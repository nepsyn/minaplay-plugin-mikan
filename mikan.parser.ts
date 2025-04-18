import {
  ApiPaginationResultDto,
  Episode,
  File,
  MinaPlayPluginHooks,
  MinaPlayPluginParser,
  MinaPlayPluginSource,
  MinaPlayPluginSourceCalendarDay,
  MinaPlayPluginSourceEpisode,
  MinaPlayPluginSourceSeries,
  PluginSourceParser,
  RuleEntryValidatorContext,
  RuleFileDescriberContext,
  RuleFileDescriptor,
} from '@minaplay/server';
import { JSDOM } from 'jsdom';
import { BgmEpisode, BgmSubject } from './bangumi.interface.js';
import aniep from 'aniep';
import { FeedEntry } from '@extractus/feed-extractor';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigService } from '@nestjs/config';
import process from 'node:process';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

export interface MikanConfig {
  base: string;
  imageProxy: string | undefined;
  include: string[];
  exclude: string[];
}

@MinaPlayPluginParser()
export class MikanParser implements PluginSourceParser, MinaPlayPluginHooks {
  private cache = new Map<string | number, Set<string>>();
  agent?: HttpsProxyAgent<string>;

  public static CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mikan.json');
  public static DEFAULT_CONFIG: MikanConfig = {
    base: 'https://mikanime.tv',
    imageProxy: undefined,
    include: [],
    exclude: ['CR', 'B-Global'],
  };
  private config: MikanConfig = Object.assign({}, MikanParser.DEFAULT_CONFIG);
  private static IMG_BASE = 'https://mikanani.me';

  async setConfig<K extends keyof MikanConfig>(key: K, value: MikanConfig[K]) {
    this.config[key] = value;
    await this.saveConfig();
  }

  getConfig() {
    return this.config;
  }

  cleanCache() {
    this.cache.clear();
  }

  async saveConfig() {
    await fs.writeFile(MikanParser.CONFIG_PATH, JSON.stringify(this.config));
  }

  async onPluginInit() {
    try {
      const buffer = await fs.readFile(MikanParser.CONFIG_PATH);
      const config = JSON.parse(buffer.toString()) as MikanConfig;
      if (typeof config.base === 'string') {
        this.config.base = config.base;
      }
      if (typeof config.imageProxy === 'string') {
        this.config.imageProxy = config.imageProxy;
      }
      if (Array.isArray(config.include)) {
        this.config.include = config.include.map((v) => String(v));
      }
      if (Array.isArray(config.exclude)) {
        this.config.exclude = config.exclude.map((v) => String(v));
      }
    } catch {}
  }

  private getImageUrl(target: string) {
    const url = new URL(target);
    const link = `${MikanParser.IMG_BASE}${url.pathname}`;
    return this.config.imageProxy ? `${this.config.imageProxy}?url=${link}` : link;
  }

  constructor(
    @InjectRepository(Episode) private episodeRepo: Repository<Episode>,
    configService: ConfigService,
  ) {
    const proxy = configService.get('APP_HTTP_PROXY') || process.env.HTTP_PROXY;
    if (proxy) {
      this.agent = new HttpsProxyAgent(proxy);
    }
  }

  async getSeriesFromBangumi(id: string): Promise<MinaPlayPluginSourceSeries> {
    const response = await fetch(`https://api.bgm.tv/v0/subjects/${id}`, {
      agent: this.agent,
      headers: {
        'User-Agent': 'nepsyn/minaplay-plugin-mikan',
      },
    });
    const item = (await response.json()) as BgmSubject;
    return {
      id: item.id,
      name: item.name_cn || item.name,
      description: item.summary,
      posterUrl: item.images?.common,
      count: item.total_episodes,
      pubAt: new Date(item.date),
      tags: (item.tags ?? []).map(({ name }) => name),
    };
  }

  async getEpisodesFromBangumi(
    id: string | number,
    page?: number,
    size?: number,
  ): Promise<ApiPaginationResultDto<MinaPlayPluginSourceEpisode>> {
    const response = await fetch(
      `https://api.bgm.tv/v0/episodes?subject_id=${id}&type=0&offset=${(page ?? 0) * (size ?? 100)}&limit=${size ?? 100}`,
      {
        agent: this.agent,
        headers: {
          'User-Agent': 'nepsyn/minaplay-plugin-mikan',
        },
      },
    );
    const result = (await response.json()) as { data: BgmEpisode[]; total: number };
    return new ApiPaginationResultDto(
      result.data.map((item) => ({
        title: item.name_cn || item.name,
        no: String(item.ep).padStart(2, '0'),
        pubAt: Date.parse(item.airdate) ? new Date(item.airdate) : undefined,
      })),
      result.total,
      page,
      size,
    );
  }

  async getCalendar() {
    const html = await fetch(this.config.base, { agent: this.agent });
    const { window } = new JSDOM(await html.arrayBuffer());
    const calendarEls = window.document.querySelectorAll('.sk-bangumi');
    const calendar: MinaPlayPluginSourceCalendarDay[] = [];
    for (const calendarEl of calendarEls) {
      const weekday = Number(calendarEl.getAttribute('data-dayofweek'));
      if (weekday < 0 || weekday > 6) {
        continue;
      }

      const bangumiEls = calendarEl.querySelectorAll('li');
      const items: MinaPlayPluginSourceSeries[] = [];
      for (const bangumiEl of bangumiEls) {
        const id = bangumiEl.querySelector('span')?.getAttribute('data-bangumiid');
        const name = bangumiEl.querySelector('.an-text')?.getAttribute('title');
        if (!id || !name) {
          continue;
        }
        const posterUrl = this.config.base + bangumiEl.querySelector('span')?.getAttribute('data-src');
        items.push({
          id,
          name,
          posterUrl: this.getImageUrl(posterUrl),
        });
      }
      calendar.push({
        weekday: weekday as any,
        items,
      });
    }
    return calendar.sort((a, b) => a.weekday - b.weekday);
  }

  async getWindowAndBgmById(id: string | number) {
    const html = await fetch(`${this.config.base}/Home/Bangumi/${id}`, { agent: this.agent });
    const { window } = new JSDOM(await html.arrayBuffer());
    const bangumiHref = [...window.document.querySelectorAll('.w-other-c').values()]
      .find((el) => el.getAttribute('href')?.match(/bgm\.tv\/subject\/\d+/))
      .getAttribute('href');
    const [, bangumiId] = bangumiHref.match(/bgm\.tv\/subject\/(\d+)/);
    return [window, bangumiId] as const;
  }

  async getSeriesById(id: string | number) {
    const [, bangumiId] = await this.getWindowAndBgmById(id);
    const series = await this.getSeriesFromBangumi(bangumiId);
    return {
      ...series,
      id,
    };
  }

  async getEpisodesBySeriesId(id: string | number, page?: number, size?: number) {
    const [window, bangumiId] = await this.getWindowAndBgmById(id);
    const episodes = await this.getEpisodesFromBangumi(bangumiId, page, size);
    const downloadUrlMap = new Map<number, { title: string; url: string }[]>();
    window.document.querySelectorAll('a.magnet-link-wrap').forEach((el) => {
      let no = aniep(el.innerHTML);
      no = Array.isArray(no) ? undefined : Number(no);
      if (no !== undefined) {
        const items = downloadUrlMap.get(no) ?? [];
        items.push({ title: el.innerHTML, url: el.nextElementSibling?.getAttribute('data-clipboard-text') });
        downloadUrlMap.set(no, items);
      }
    });
    for (const ep of episodes.items) {
      ep.downloadUrl = downloadUrlMap.get(Number(ep.no));
    }
    return episodes;
  }

  async searchSeries(keyword: string) {
    const html = await fetch(`${this.config.base}/Home/Search?searchstr=${encodeURIComponent(keyword)}`, {
      agent: this.agent,
    });
    const { window } = new JSDOM(await html.arrayBuffer());
    const bangumiEls = window.document.querySelectorAll('.an-ul > li');
    const items: MinaPlayPluginSourceSeries[] = [];
    for (const bangumiEl of bangumiEls) {
      const id = bangumiEl.querySelector('a')?.getAttribute('href').split('/').at(-1);
      const name = bangumiEl.querySelector('.an-text')?.getAttribute('title');
      if (!id || !name) {
        continue;
      }
      const posterUrl = this.config.base + bangumiEl.querySelector('span')?.getAttribute('data-src');
      items.push({
        id,
        name,
        posterUrl: this.getImageUrl(posterUrl),
      });
    }
    return new ApiPaginationResultDto(items, items.length, 0, items.length);
  }

  async buildSourceOfSeries(series: MinaPlayPluginSourceSeries): Promise<MinaPlayPluginSource> {
    return {
      name: series.name,
      url: `${this.config.base}/RSS/Bangumi?bangumiId=${series.id}`,
      site: `${this.config.base}/Home/Bangumi/${series.id}`,
    };
  }

  async buildRuleCodeOfSeries(series: MinaPlayPluginSourceSeries): Promise<string> {
    return MIKAN_RULE_TEMPLATE(series.id, series.name, series.season, this.config.include, this.config.exclude);
  }

  async validateFeedEntry(entry: FeedEntry, ctx: RuleEntryValidatorContext): Promise<boolean> {
    let no = aniep(entry.title);
    no = Array.isArray(no) ? undefined : String(no).padStart(2, '0');
    const id: string | number = ctx.meta['id'];
    if (!id || !ctx.meta['name']) {
      return false;
    }
    if (!this.cache.has(id)) {
      this.cache.set(id, new Set());
    }
    const include: string[] = ctx.meta['include'] ?? [];
    if (include.some((v) => !entry.title.includes(v))) {
      return false;
    }
    const exclude: string[] = ctx.meta['exclude'] ?? [];
    if (exclude.some((v) => entry.title.includes(v))) {
      return false;
    }
    if (typeof no === 'string' && !this.cache.get(id).has(no)) {
      this.cache.get(id).add(no);
      const episode = await this.episodeRepo.findOneBy({
        no,
        series: { name: ctx.meta['name'], ...(ctx.meta['season'] ? { season: ctx.meta['season'] } : undefined) },
      });
      return !episode;
    }
    return false;
  }

  describeDownloadItem(entry: FeedEntry, file: File, ctx: RuleFileDescriberContext): RuleFileDescriptor {
    let no = aniep(entry.title);
    no = Array.isArray(no) ? undefined : String(no).padStart(2, '0');
    return {
      series: {
        name: ctx.meta['name'],
        season: ctx.meta['season'],
      },
      episode: {
        title: file.name,
        no,
        pubAt: entry.published && new Date(entry.published),
      },
      overwriteEpisode: true,
    };
  }
}

const MIKAN_RULE_TEMPLATE = (
  id: string | number,
  name: string,
  season: string | undefined,
  include: string[],
  exclude: string[],
) => `export default {
  validate: 'mikan:${MikanParser.name}',
  describe: 'mikan:${MikanParser.name}',
  meta: {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(name)},
    season: ${JSON.stringify(season)},
    include: ${JSON.stringify(include)},
    exclude: ${JSON.stringify(exclude)},
  },
}`;
