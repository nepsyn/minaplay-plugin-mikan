import { MinaPlayCommand, MinaPlayCommandArgument, MinaPlayListenerInject, Text } from '@minaplay/server';
import { Injectable } from '@nestjs/common';
import { Command } from 'commander';
import { MikanParser } from './mikan.parser.js';

@Injectable()
export class MikanCommand {
  constructor(private parser: MikanParser) {}

  @MinaPlayCommand('mikan', {
    description: 'Mikan support in MinaPlay',
  })
  handleMikan(@MinaPlayListenerInject() program: Command) {
    return program.helpInformation();
  }

  @MinaPlayCommand('set-base', {
    description: 'set base url of mikan',
    parent: () => MikanCommand.prototype.handleMikan,
  })
  async handleSetBase(
    @MinaPlayCommandArgument('<url>', {
      description: 'base url',
    })
    url: string,
  ) {
    await this.parser.setBase(url.endsWith('/') ? url.slice(0, url.length - 1) : url);
    return new Text(`Change base url to: ${url}`, Text.Colors.SUCCESS);
  }

  @MinaPlayCommand('set-image-proxy', {
    description: 'set image proxy url of mikan',
    parent: () => MikanCommand.prototype.handleMikan,
  })
  async handleSetImageProxy(
    @MinaPlayCommandArgument('<url>', {
      description: 'image proxy url',
    })
    url: string,
  ) {
    await this.parser.setImageProxy(url);
    return new Text(`Change image proxy url to: ${url}`, Text.Colors.SUCCESS);
  }
}
