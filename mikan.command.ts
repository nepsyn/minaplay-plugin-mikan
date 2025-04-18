import { MinaPlayCommand, MinaPlayCommandArgument, MinaPlayListenerInject, Text } from '@minaplay/server';
import { Injectable } from '@nestjs/common';
import { Command } from 'commander';
import { MikanConfig, MikanParser } from './mikan.parser.js';

@Injectable()
export class MikanCommand {
  constructor(private parser: MikanParser) {}

  private static CONFIG_MAP: Record<string, keyof MikanConfig> = {
    'image-proxy': 'imageProxy',
    base: 'base',
    include: 'include',
    exclude: 'exclude',
  };

  @MinaPlayCommand('mikan', {
    description: 'Mikan support in MinaPlay',
  })
  handleMikan(@MinaPlayListenerInject() program: Command) {
    return program.helpInformation();
  }

  @MinaPlayCommand('config', {
    description: 'Show configs of plugin',
    parent: () => MikanCommand.prototype.handleMikan,
  })
  handleConfig(@MinaPlayListenerInject() program: Command) {
    return program.helpInformation();
  }

  @MinaPlayCommand('list', {
    description: 'show configs',
    parent: () => MikanCommand.prototype.handleConfig,
  })
  async handleConfigList() {
    return Object.entries(MikanCommand.CONFIG_MAP)
      .map(([label, key]) => `${label.padEnd(12, ' ')} : ${JSON.stringify(this.parser.getConfig()[key])}`)
      .join('\n');
  }

  @MinaPlayCommand('set', {
    description: 'set configs',
    parent: () => MikanCommand.prototype.handleConfig,
  })
  async handleConfigSet(
    @MinaPlayCommandArgument('<key>', {
      description: 'config key',
      factory: (arg) => arg.choices(Object.keys(MikanCommand.CONFIG_MAP)),
    })
    key: keyof typeof MikanCommand.CONFIG_MAP,
    @MinaPlayCommandArgument('<args...>', {
      description: 'args',
    })
    args: string[],
  ) {
    if (!Object.keys(MikanCommand.CONFIG_MAP).includes(key)) {
      return new Text(`No config named '${key}'`, Text.Colors.ERROR);
    }
    if (args.length < 1) {
      return new Text(`Invalid args count`, Text.Colors.ERROR);
    }
    if (['base', 'imageProxy'].includes(key)) {
      await this.parser.setConfig(MikanCommand.CONFIG_MAP[key], args[0]);
    } else if (['include', 'exclude'].includes(key)) {
      await this.parser.setConfig(MikanCommand.CONFIG_MAP[key], args);
    }
    return new Text(JSON.stringify(this.parser.getConfig()[MikanCommand.CONFIG_MAP[key]]));
  }

  @MinaPlayCommand('get', {
    description: 'get config',
    parent: () => MikanCommand.prototype.handleConfig,
  })
  async handleConfigGet(
    @MinaPlayCommandArgument('<key>', {
      description: 'config key',
      factory: (arg) => arg.choices(Object.keys(MikanCommand.CONFIG_MAP)),
    })
    key: keyof typeof MikanCommand.CONFIG_MAP,
  ) {
    if (!Object.keys(MikanCommand.CONFIG_MAP).includes(key)) {
      return new Text(`No config named '${key}'`, Text.Colors.ERROR);
    }
    return new Text(JSON.stringify(this.parser.getConfig()[MikanCommand.CONFIG_MAP[key]]));
  }

  @MinaPlayCommand('unset', {
    description: 'unset configs(restore default)',
    parent: () => MikanCommand.prototype.handleConfig,
  })
  async handleConfigUnset(
    @MinaPlayCommandArgument('<key>', {
      description: 'config key',
      factory: (arg) => arg.choices(Object.keys(MikanCommand.CONFIG_MAP)),
    })
    key: keyof typeof MikanCommand.CONFIG_MAP,
  ) {
    if (!Object.keys(MikanCommand.CONFIG_MAP).includes(key)) {
      return new Text(`No config named '${key}'`, Text.Colors.ERROR);
    }
    await this.parser.setConfig(MikanCommand.CONFIG_MAP[key], MikanParser.DEFAULT_CONFIG[MikanCommand.CONFIG_MAP[key]]);
    return new Text(JSON.stringify(this.parser.getConfig()[MikanCommand.CONFIG_MAP[key]]));
  }

  @MinaPlayCommand('clean-cache', {
    aliases: ['cc'],
    description: 'clean download cache',
    parent: () => MikanCommand.prototype.handleMikan,
  })
  async handleCleanCache() {
    this.parser.cleanCache();
    return new Text(`Download cache cleaned`, Text.Colors.SUCCESS);
  }
}
