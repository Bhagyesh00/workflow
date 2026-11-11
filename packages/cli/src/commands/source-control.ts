/** `workflow source-control pull` (P6-77): pulls the connected Git branch into the workspace. */
import { flagOn, flagText, UsageError } from '../args';
import type { CommandGroup } from '../client';

const AUTO_PUBLISH = ['none', 'all', 'published'];

export const sourceControlCommands: CommandGroup = {
  pull: {
    summary:
      'Pull the connected branch (--force overwrites local changes; --auto-publish none|all|published)',
    usage: 'workflow source-control pull [--force] [--auto-publish none|all|published]',
    async run(ctx) {
      const autoPublish = flagText(ctx.args, 'auto-publish');
      if (autoPublish !== undefined && !AUTO_PUBLISH.includes(autoPublish)) {
        throw new UsageError(`--auto-publish must be one of: ${AUTO_PUBLISH.join(', ')}`);
      }
      const body = { force: flagOn(ctx.args, 'force') ? true : undefined, autoPublish };
      ctx.print(await (await ctx.api()).data('POST', '/source-control/pull', { body }));
    },
  },
};
