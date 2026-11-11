/** `workflow user ...` (P6-77): users on the public API. */
import { flagOn, flagText, wordRequired } from '../args';
import { type CommandGroup, pagingOf } from '../client';

const COLUMNS = ['id', 'email', 'firstName', 'lastName', 'role'] as const;
const enc = encodeURIComponent;

export const userCommands: CommandGroup = {
  list: {
    summary: 'List users',
    usage: 'workflow user list [--include-role] [--project-id <id>] [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list(
        '/users',
        {
          ...query,
          includeRole: flagOn(ctx.args, 'include-role') ? true : undefined,
          projectId: flagText(ctx.args, 'project-id'),
        },
        { all },
      );
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one user by id or email',
    usage: 'workflow user get <id-or-email> [--include-role]',
    async run(ctx) {
      const who = wordRequired(ctx.args, 0, 'id-or-email');
      const query = { includeRole: flagOn(ctx.args, 'include-role') ? true : undefined };
      ctx.print(await (await ctx.api()).data('GET', `/users/${enc(who)}`, { query }));
    },
  },
};
