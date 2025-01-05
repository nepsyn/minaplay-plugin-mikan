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

@MinaPlayPluginParser()
export class MikanParser implements PluginSourceParser, MinaPlayPluginHooks {
  private cache = new Map<string | number, Set<string>>();
  agent?: HttpsProxyAgent<string>;

  public static CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mikan.json');
  private base = 'https://mikanime.tv';
  private static IMG_BASE = 'https://mikanani.me';
  private imageProxy: string | undefined = undefined;

  async setBase(base: string) {
    this.base = base;
    await this.saveConfig();
  }

  async setImageProxy(url: string) {
    this.imageProxy = url;
    await this.saveConfig();
  }

  async saveConfig() {
    await fs.writeFile(
      MikanParser.CONFIG_PATH,
      JSON.stringify({
        base: this.base,
        imageProxy: this.imageProxy,
      }),
    );
  }

  async onPluginInit() {
    try {
      const buffer = await fs.readFile(MikanParser.CONFIG_PATH);
      const config = JSON.parse(buffer.toString());
      if (typeof config.base === 'string') {
        this.base = config.base;
      }
      if (typeof config.imageProxy === 'string') {
        this.imageProxy = config.imageProxy;
      }
    } catch {}
  }

  private getImageUrl(target: string) {
    const url = new URL(target);
    const link = `${MikanParser.IMG_BASE}${url.pathname}`;
    return this.imageProxy ? `${this.imageProxy}?url=${link}` : link;
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
    const html = await fetch(this.base, { agent: this.agent });
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
        const posterUrl = this.base + bangumiEl.querySelector('span')?.getAttribute('data-src');
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
    const html = await fetch(`${this.base}/Home/Bangumi/${id}`, { agent: this.agent });
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
    const downloadUrlMap = new Map<number, string>();
    window.document.querySelectorAll('a.magnet-link-wrap').forEach((el) => {
      let no = aniep(el.innerHTML);
      no = Array.isArray(no) ? undefined : Number(no);
      if (no !== undefined && !downloadUrlMap.has(no)) {
        downloadUrlMap.set(no, el.nextElementSibling?.getAttribute('data-clipboard-text'));
      }
    });
    for (const ep of episodes.items) {
      ep.downloadUrl = downloadUrlMap.get(Number(ep.no));
    }
    return episodes;
  }

  async searchSeries(keyword: string) {
    const html = await fetch(`${this.base}/Home/Search?searchstr=${encodeURIComponent(keyword)}`, {
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
      const posterUrl = this.base + bangumiEl.querySelector('span')?.getAttribute('data-src');
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
      url: `${this.base}/RSS/Bangumi?bangumiId=${series.id}`,
      site: `${this.base}/Home/Bangumi/${series.id}`,
    };
  }

  async buildRuleCodeOfSeries(series: MinaPlayPluginSourceSeries): Promise<string> {
    return (
      `export default {` +
      `  validate: 'mikan:${MikanParser.name}',` +
      `  describe: 'mikan:${MikanParser.name}',` +
      `  meta: { name: ${JSON.stringify(series.name)}, session: ${JSON.stringify(series.season)}, id: ${JSON.stringify(series.id)} } }`
    );
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
    if (typeof no === 'string' && !this.cache.get(id).has(no)) {
      this.cache.get(id).add(no);
      const episode = await this.episodeRepo.findOneBy({
        no,
        series: { name: ctx.meta['name'], ...(ctx.meta['session'] ? { session: ctx.meta['session'] } : undefined) },
      });
      return !episode;
    }
    return false;
  }

  describeDownloadItem(entry: FeedEntry, file: File, ctx: RuleFileDescriberContext): RuleFileDescriptor {
    return {
      series: {
        name: ctx.meta['name'],
        season: ctx.meta['session'],
      },
      episode: {
        title: file.name,
        no: String(aniep(entry.title)),
        pubAt: entry.published && new Date(entry.published),
      },
      overwriteEpisode: true,
    };
  }
}
