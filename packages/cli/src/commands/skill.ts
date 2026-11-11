/** `workflow skill install` (P6-77): writes the agent skill file for Claude Code, Cursor or Windsurf. */
import { flagOn, flagText, UsageError } from '../args';
import type { CommandGroup } from '../client';
import { SKILL_TARGETS, type SkillTarget, skillFor, skillPath } from '../skill';

export const skillCommands: CommandGroup = {
  install: {
    summary:
      'Install the skill in this folder, or with --global in your home folder (--target claude|cursor|windsurf)',
    usage: 'workflow skill install [--global] [--target claude|cursor|windsurf]',
    async run(ctx) {
      const target = flagText(ctx.args, 'target') ?? 'claude';
      if (!(SKILL_TARGETS as readonly string[]).includes(target)) {
        throw new UsageError(`--target must be one of: ${SKILL_TARGETS.join(', ')}`);
      }
      const path = skillPath(target as SkillTarget, flagOn(ctx.args, 'global'), ctx.io.home);
      await ctx.io.writeFile(path, skillFor(target as SkillTarget), {});
      ctx.print({ target, path });
    },
  },
};
