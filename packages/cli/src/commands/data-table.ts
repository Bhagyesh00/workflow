/** `workflow data-table ...` (P6-77): data tables and their rows on the public API. */
import { flagOn, flagRequired, flagText, UsageError, wordRequired } from '../args';
import { type CommandGroup, type Ctx, pagingOf } from '../client';

const COLUMNS = ['id', 'name', 'projectId', 'updatedAt'] as const;
const enc = encodeURIComponent;

/** a `--filter` as JSON text, checked to be JSON so a typo fails here and not as a server 400 */
function filterText(ctx: Ctx, required: boolean): string | undefined {
  const text = required ? flagRequired(ctx.args, 'filter') : flagText(ctx.args, 'filter');
  if (text === undefined) return undefined;
  try {
    JSON.parse(text);
  } catch {
    throw new UsageError(
      '--filter must be JSON, for example {"type":"and","filters":[{"columnName":"a","value":1}]}',
    );
  }
  return text;
}

/** `{ filter, data }` from --filter and --data, or the JSON of --file or --stdin */
async function changeBody(ctx: Ctx): Promise<unknown> {
  const data = flagText(ctx.args, 'data');
  if (data !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new UsageError('--data must be JSON, for example {"status":"done"}');
    }
    return {
      filter: JSON.parse(filterText(ctx, true) as string),
      data: parsed,
      dryRun: flagOn(ctx.args, 'dry-run'),
    };
  }
  const body = await ctx.body();
  if (!flagOn(ctx.args, 'dry-run')) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UsageError('--dry-run needs a JSON object with filter and data');
  }
  return { ...body, dryRun: true };
}

export const dataTableCommands: CommandGroup = {
  list: {
    summary: 'List data tables',
    usage: 'workflow data-table list [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list('/data-tables', query, { all });
      ctx.print(page.data, COLUMNS);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  get: {
    summary: 'Show one data table with its columns',
    usage: 'workflow data-table get <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('GET', `/data-tables/${enc(id)}`));
    },
  },
  create: {
    summary: 'Create a data table from JSON ({ name, columns: [{ name, type }], projectId? })',
    usage: 'workflow data-table create (--file <path> | --stdin)',
    async run(ctx) {
      const body = await ctx.body();
      ctx.print(await (await ctx.api()).data('POST', '/data-tables', { body }), COLUMNS);
    },
  },
  delete: {
    summary: 'Delete a data table and its rows',
    usage: 'workflow data-table delete <id>',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      ctx.print(await (await ctx.api()).data('DELETE', `/data-tables/${enc(id)}`));
    },
  },
  rows: {
    summary: 'List the rows of a data table',
    usage:
      'workflow data-table rows <id> [--filter <json>] [--search <text>] [--sort-by <col:asc|col:desc>] [--limit n] [--cursor c] [--all]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const { query, all } = pagingOf(ctx.args);
      const page = await (await ctx.api()).list(
        `/data-tables/${enc(id)}/rows`,
        {
          ...query,
          filter: filterText(ctx, false),
          search: flagText(ctx.args, 'search'),
          sortBy: flagText(ctx.args, 'sort-by'),
        },
        { all },
      );
      ctx.print(page.data);
      if (page.nextCursor) ctx.note(`More results: --cursor ${page.nextCursor} (or --all)`);
    },
  },
  'add-rows': {
    summary: 'Insert rows: a JSON array of rows, or { data: [...], returnType } (--return-type all|id|count)',
    usage: 'workflow data-table add-rows <id> (--file <path> | --stdin) [--return-type all|id|count]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const input = await ctx.body();
      const body = Array.isArray(input) ? { data: input } : (input as Record<string, unknown>);
      const returnType = flagText(ctx.args, 'return-type');
      const full = returnType ? { ...body, returnType } : body;
      ctx.print(await (await ctx.api()).data('POST', `/data-tables/${enc(id)}/rows`, { body: full }));
    },
  },
  'update-rows': {
    summary: 'Change the rows that match: --filter and --data, or { filter, data } in a file or stdin',
    usage:
      'workflow data-table update-rows <id> (--filter <json> --data <json> | --file <path> | --stdin) [--dry-run]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = await changeBody(ctx);
      ctx.print(await (await ctx.api()).data('PATCH', `/data-tables/${enc(id)}/rows/update`, { body }));
    },
  },
  'upsert-rows': {
    summary:
      'Change the row that matches, or insert one: --filter and --data, or { filter, data } in a file or stdin',
    usage:
      'workflow data-table upsert-rows <id> (--filter <json> --data <json> | --file <path> | --stdin) [--dry-run]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const body = await changeBody(ctx);
      ctx.print(await (await ctx.api()).data('POST', `/data-tables/${enc(id)}/rows/upsert`, { body }));
    },
  },
  'delete-rows': {
    summary: 'Delete the rows that match a filter',
    usage: 'workflow data-table delete-rows <id> --filter <json> [--dry-run]',
    async run(ctx) {
      const id = wordRequired(ctx.args, 0, 'id');
      const query = { filter: filterText(ctx, true), dryRun: flagOn(ctx.args, 'dry-run') ? true : undefined };
      ctx.print(await (await ctx.api()).data('DELETE', `/data-tables/${enc(id)}/rows/delete`, { query }));
    },
  },
};
