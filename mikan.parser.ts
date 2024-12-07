import {
  ApiPaginationResultDto,
  Episode,
  File,
  getMinaPlayPluginParserMetadata,
  MinaPlayPluginHooks,
  MinaPlayPluginParser,
  MinaPlayPluginSource,
  MinaPlayPluginSourceCalendarDay,
  MinaPlayPluginSourceEpisode,
  MinaPlayPluginSourceSeries,
  PluginService,
  PluginSourceParser,
  Rule,
  RuleFileDescriptor,
} from '@minaplay/server';
import { JSDOM } from 'jsdom';
import { BgmEpisode, BgmSubject } from './bangumi.interface.js';
import aniep from 'aniep';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { FeedEntry } from '@extractus/feed-extractor';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

@MinaPlayPluginParser()
export class MikanParser implements PluginSourceParser, MinaPlayPluginHooks {
  public static CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mikan.json');
  private base = 'https://mikanime.tv';
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

    const rules = await this.ruleRepository.findBy({
      parserMeta: Like(`mikan-${MikanParser.name}-%`),
    });
    const tasks = rules.map((rule) =>
      (async () => {
        const id = rule.parserMeta.match(/(\d+)/g)?.[0];
        if (id) {
          const series = await this.getSeriesById(id);
          this.initDelegateForSeries(series);
        }
      })(),
    );
    await Promise.allSettled(tasks);
  }

  private getImageUrl(target: string) {
    const url = new URL(target);
    const link = `${url.origin}${url.pathname}`;
    return this.imageProxy ? `${this.imageProxy}?url=${link}` : link;
  }

  constructor(
    @InjectRepository(Episode) private episodeRepository: Repository<Episode>,
    @InjectRepository(Rule) private ruleRepository: Repository<Rule>,
    private pluginService: PluginService,
  ) {}

  async getSeriesFromBangumi(id: string): Promise<MinaPlayPluginSourceSeries> {
    const response = await fetch(`https://api.bgm.tv/v0/subjects/${id}`, {
      headers: {
        'User-Agent': 'nepsyn/minaplay-plugin-mikan',
      },
    });
    const item: BgmSubject = await response.json();
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
        headers: {
          'User-Agent': 'nepsyn/minaplay-plugin-mikan',
        },
      },
    );
    const result: { data: BgmEpisode[]; total: number } = await response.json();
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
    const { window } = await JSDOM.fromURL(this.base);
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

  async getSeriesById(id: string) {
    const { window } = await JSDOM.fromURL(`${this.base}/Home/Bangumi/${id}`);
    const bangumiHref = [...window.document.querySelectorAll('.w-other-c').values()]
      .find((el) => el.getAttribute('href')?.match(/bgm\.tv\/subject\/\d+/))
      .getAttribute('href');
    const [, bangumiId] = bangumiHref.match(/bgm\.tv\/subject\/(\d+)/);
    const series = await this.getSeriesFromBangumi(bangumiId);
    return {
      ...series,
      id,
    };
  }

  async getEpisodesBySeriesId(id: string | number, page?: number, size?: number) {
    const { window } = await JSDOM.fromURL(`${this.base}/Home/Bangumi/${id}`);
    const bangumiHref = [...window.document.querySelectorAll('.w-other-c').values()]
      .find((el) => el.getAttribute('href')?.match(/bgm\.tv\/subject\/\d+/))
      .getAttribute('href');
    const [, bangumiId] = bangumiHref.match(/bgm\.tv\/subject\/(\d+)/);
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
    const { window } = await JSDOM.fromURL(`${this.base}/Home/Search?searchstr=${encodeURIComponent(keyword)}`);
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

  private initDelegateForSeries(series: MinaPlayPluginSourceSeries) {
    const repo = this.episodeRepository;

    @MinaPlayPluginParser({
      name: `bangumi-${series.id}`,
    })
    class MikanParserDelegate implements PluginSourceParser {
      private cache: string[] = [];

      async validateFeedEntry(entry: FeedEntry): Promise<boolean> {
        let no = aniep(entry.title);
        no = Array.isArray(no) ? undefined : String(no).padStart(2, '0');
        if (typeof no === 'string' && !this.cache.includes(no)) {
          this.cache.push(no);
          const episode = await repo.findOneBy({
            no,
            series: { name: series.name, season: series.season },
          });
          return !episode;
        }
        return false;
      }

      describeDownloadItem(entry: FeedEntry, file: File, _: File[]): RuleFileDescriptor {
        return {
          series: {
            name: series.name,
            season: series.season,
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

    this.pluginService.getControlById('mikan').parserMap.set(`bangumi-${series.id}`, {
      ...getMinaPlayPluginParserMetadata(MikanParserDelegate),
      service: new MikanParserDelegate(),
    });
  }

  async buildRuleCodeOfSeries(series: MinaPlayPluginSourceSeries): Promise<string> {
    this.initDelegateForSeries(series);
    return `export default { validate: 'mikan:bangumi-${series.id}', describe: 'mikan:bangumi-${series.id}' }`;
  }
}
