/** `workflow variable ...` (P6-77): variables on the public API. A value is shown as the API answers it. */
import { flagBool, flagRequired, flagText, UsageError, wordRequired } from '../args';
import { CliError, type CommandGroup, EXIT } from '../client';

const COLUMNS = ['id', 'key', 'value', 'projectId'] as const;
const enc = encodeURIComponent;

export const variableCommands: CommandGroup = {
  list: {
    summary: 'List variables (--empty keeps the ones with no value)',
    usage: 'workflow variable list [--project-id <id>] [--empty]',
    async run(ctx) {
      const query = {
        projectId: flagText(ctx.args, 'project-id'),
        state: flagBool(ctx.args, 'empty') ? 'empty' : undefined,
      };
      const page = await (await ctx.api()).list('/variables', query, { all: true });
      ctx.print(page.data, COLUMNS);
    },
  },
  get: {
    summary: 'Show one variable (found in the list: the API has no single-variable route)',
    usage: 'workflow variable get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const page = await (await ctx.api()).list('/variables', {}, { all: true });
      const found = page.data.find((row) => (row as { id?: unknown }).id === id);
      if (!found) throw new CliError(`Variable ${id} not found`, EXIT.notFound);
      ctx.print(found);
    },
  },
  create: {
    summary: 'Create a variable',
    usage: 'workflow variable create --key <name> --value <text> [--project-id <id>]',
    async run(ctx) {
      const body = {
        key: flagRequired(ctx.args, 'key'),
        value: flagText(ctx.args, 'value') ?? '',
        projectId: flagText(ctx.args, 'project-id'),
      };
      ctx.print(await (await ctx.api()).data('POST', '/variables', { body }), COLUMNS);
    },
  },
  update: {
    summary: 'Change the key or the value of a variable',
    usage: 'workflow variable update <id> [--key <name>] [--value <text>]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = { key: flagText(ctx.args, 'key'), value: flagText(ctx.args, 'value') };
      if (body.key === undefined && body.value === undefined) throw new UsageError('Give --key or --value');
      ctx.print(await (await ctx.api()).data('PUT', `/variables/${enc(id)}`, { body }), COLUMNS);
    },
  },
  delete: {
    summary: 'Delete a variable',
    usage: 'workflow variable delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/variables/${enc(id)}`));
    },
  },
};
