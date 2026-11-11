/**
 * `workflow credential ...` (P6-77). The API never answers secret data for a credential; `create` sends the data
 * from the file or stdin and prints only the new credential's id, name and type.
 */
import { flagRequired, wordRequired } from '../args';
import { type CommandGroup, pagingOf } from '../client';

const COLUMNS = ['id', 'name', 'type', 'updatedAt'] as const;
const enc = encodeURIComponent;

export const credentialCommands: CommandGroup = {
  list: {
    summary: 'List credentials (names and types)',
    usage: 'workflow credential list [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list('/credentials', query, { all });
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one credential (no data)',
    usage: 'workflow credential get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('GET', `/credentials/${enc(id)}`));
    },
  },
  schema: {
    summary: 'Show the JSON schema of the data of a credential type',
    usage: 'workflow credential schema <type>',
    async run(ctx) {
      const type = wordRequired(ctx.args, 0, 'type');
      ctx.print(await (await ctx.api()).data('GET', `/credentials/schema/${enc(type)}`));
    },
  },
  create: {
    summary: 'Create a credential from JSON ({ name, type, data, projectId? })',
    usage: 'workflow credential create (--file <path> | --stdin)',
    async run(ctx) {
      const body = await ctx.body();
      ctx.print(await (await ctx.api()).data('POST', '/credentials', { body }), ['id', 'name', 'type']);
    },
  },
  delete: {
    summary: 'Delete a credential',
    usage: 'workflow credential delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/credentials/${enc(id)}`));
    },
  },
  transfer: {
    summary: 'Move a credential to another project',
    usage: 'workflow credential transfer <id> --destination-project-id <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = { destinationProjectId: flagRequired(ctx.args, 'destination-project-id') };
      ctx.print(await (await ctx.api()).data('PUT', `/credentials/${enc(id)}/transfer`, { body }));
    },
  },
};
