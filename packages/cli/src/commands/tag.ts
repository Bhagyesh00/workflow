/** `workflow tag ...` (P6-77): tags on the public API. */
import { flagRequired, wordRequired } from '../args';
import { type CommandGroup, pagingOf } from '../client';

const COLUMNS = ['id', 'name', 'updatedAt'] as const;
const enc = encodeURIComponent;

export const tagCommands: CommandGroup = {
  list: {
    summary: 'List tags',
    usage: 'workflow tag list [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list('/tags', query, { all });
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one tag',
    usage: 'workflow tag get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('GET', `/tags/${enc(id)}`));
    },
  },
  create: {
    summary: 'Create a tag',
    usage: 'workflow tag create --name <text>',
    async run(ctx) {
      const body = { name: flagRequired(ctx.args, 'name') };
      ctx.print(await (await ctx.api()).data('POST', '/tags', { body }), COLUMNS);
    },
  },
  update: {
    summary: 'Rename a tag',
    usage: 'workflow tag update <id> --name <text>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = { name: flagRequired(ctx.args, 'name') };
      ctx.print(await (await ctx.api()).data('PUT', `/tags/${enc(id)}`, { body }), COLUMNS);
    },
  },
  delete: {
    summary: 'Delete a tag',
    usage: 'workflow tag delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/tags/${enc(id)}`));
    },
  },
};
