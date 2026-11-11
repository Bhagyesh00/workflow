/** `workflow project ...` (P6-77): projects and their members on the public API. */
import { flagRequired, flagText, wordRequired } from '../args';
import { CliError, type CommandGroup, EXIT, pagingOf } from '../client';

const COLUMNS = ['id', 'name', 'type', 'description'] as const;
const enc = encodeURIComponent;

export const projectCommands: CommandGroup = {
  list: {
    summary: 'List projects',
    usage: 'workflow project list [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list('/projects', query, { all });
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one project (found in the list: the API has no single-project route)',
    usage: 'workflow project get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const page = await (await ctx.api()).list('/projects', { limit: 250 }, { all: true });
      const found = page.data.find((row) => (row as { id?: unknown }).id === id);
      if (!found) throw new CliError(`Project ${id} not found`, EXIT.notFound);
      ctx.print(found);
    },
  },
  create: {
    summary: 'Create a team project',
    usage: 'workflow project create --name <text> [--description <text>]',
    async run(ctx) {
      const body = { name: flagRequired(ctx.args, 'name'), description: flagText(ctx.args, 'description') };
      ctx.print(await (await ctx.api()).data('POST', '/projects', { body }), COLUMNS);
    },
  },
  update: {
    summary: 'Rename a project or change its description',
    usage: 'workflow project update <id> [--name <text>] [--description <text>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = { name: flagText(ctx.args, 'name'), description: flagText(ctx.args, 'description') };
      ctx.print(await (await ctx.api()).data('PUT', `/projects/${enc(id)}`, { body }), COLUMNS);
    },
  },
  delete: {
    summary: 'Delete a project (--transfer-id moves its workflows and credentials to another project)',
    usage: 'workflow project delete <id> [--transfer-id <projectId>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const query = { transferId: flagText(ctx.args, 'transfer-id') };
      ctx.print(await (await ctx.api()).data('DELETE', `/projects/${enc(id)}`, { query }));
    },
  },
  members: {
    summary: 'List the members of a project',
    usage: 'workflow project members <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('GET', `/projects/${enc(id)}/users`), ['id', 'email', 'role']);
    },
  },
  'add-member': {
    summary: 'Add a user to a project with a project role',
    usage: 'workflow project add-member <id> --user-id <id> --role <role>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = {
        relations: [{ userId: flagRequired(ctx.args, 'user-id'), role: flagRequired(ctx.args, 'role') }],
      };
      ctx.print(await (await ctx.api()).data('POST', `/projects/${enc(id)}/users`, { body }));
    },
  },
  'remove-member': {
    summary: 'Remove a user from a project',
    usage: 'workflow project remove-member <id> --user-id <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const userId = flagRequired(ctx.args, 'user-id');
      ctx.print(await (await ctx.api()).data('DELETE', `/projects/${enc(id)}/users/${enc(userId)}`));
    },
  },
};
