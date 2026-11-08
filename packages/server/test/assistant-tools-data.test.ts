/**
 * P5-69 (L5): the Assistant's data table tools through L1's chat and L3's approvals on the C0e harness.
 * The role of each of the eleven tools, reads (untrusted, `artifact` for one table, `like` keeps the
 * service's rule), `create_data_table` (card with columns, an `artifact` event after the approval, the
 * table exists, a viewer cannot), the card of row writes (three rows and the omitted count), an insert
 * then the row exists, delete rows with an empty filter refused, no session button on the irreversible
 * ones, another workspace's table refused for every tool with no card, a seeded secret in a cell never
 * leaves in a request to the model, and the audit row of a delete.
 */
import type { AssistantConfirmation, AssistantEvent } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataTablesTools } from '../src/services/assistant/tools/data-tables';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import { waitFor } from './helpers';

const approve = { kind: 'approval', approved: true } as const;
type Card = Extract<AssistantConfirmation, { inputType: 'approval' }>;

let h: AssistantHarness;
const suffix = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  h = await createAssistantHarness({});
});
afterAll(async () => {
  await h?.close();
});

/** a table of the workspace made through REST, with rows */
async function makeTable(rows: Array<Record<string, string | number>> = []) {
  const name = `t_${suffix()}`;
  const table = await h.owner.client.data<{ id: string; columns: Array<{ id: string; name: string }> }>(
    h.owner.client.post('/rest/data-tables', {
      name,
      columns: [
        { name: 'name', type: 'string' },
        { name: 'qty', type: 'number' },
      ],
    }),
  );
  if (rows.length) {
    await h.owner.client.data(h.owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: rows }));
  }
  return { ...table, name };
}

const rowsOf = (id: string) =>
  h.owner.client.data<{ count: number; data: Array<Record<string, unknown>> }>(
    h.owner.client.get(`/rest/data-tables/${id}/rows?take=100`),
  );

/** one gated call: returns the card the person sees */
async function cardFor(user: HarnessUser, name: string, args: Record<string, unknown>) {
  const turn = await h.callTool(user, name, args);
  expect(turn.status.isSuspended, `${name} waits for a person`).toBe(true);
  const status = await h.waitForStatus(user, turn.threadId, (s) => s.pending.length > 0);
  return { turn, card: status.pending[0] as Card };
}

/** approves the card and returns what the model read as the tool's result */
async function approveCard(user: HarnessUser, turn: { threadId: string; toolCallId: string }, card: Card) {
  const before = h.fake.requests.length;
  const res = await h.confirm(user, card.requestId, approve);
  expect(res.statusCode).toBe(200);
  await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
  await h.waitForStatus(user, turn.threadId, 'idle');
  return toolResultOf([h.fake.requests.at(-1)], turn.toolCallId) ?? '';
}

async function eventsOf(user: HarnessUser, threadId: string): Promise<AssistantEvent[]> {
  return h.events(user, threadId, 0, {
    until: (list) => list.some((e) => e.type === 'run-finish'),
  });
}

describe('Assistant data table tools (P5-69)', () => {
  it('has the eleven tools at the roles of the data table routes', async () => {
    await h.expectToolRoles({
      list_data_tables: 'viewer',
      get_data_table_schema: 'viewer',
      query_data_table_rows: 'viewer',
      create_data_table: 'editor',
      delete_data_table: 'editor',
      add_data_table_column: 'editor',
      delete_data_table_column: 'editor',
      rename_data_table_column: 'editor',
      insert_data_table_rows: 'editor',
      update_data_table_rows: 'editor',
      delete_data_table_rows: 'editor',
    });
    expect(dataTablesTools).toHaveLength(11);
    for (const tool of dataTablesTools) {
      const read = tool.minRole === 'viewer';
      expect(tool.permission === undefined, `${tool.name} permission`).toBe(read);
      expect(tool.untrusted !== undefined, `${tool.name} untrusted`).toBe(read);
    }
    const irreversible = ['delete_data_table', 'delete_data_table_column', 'delete_data_table_rows'];
    const sample: Record<string, unknown> = {
      delete_data_table: { dataTableId: crypto.randomUUID() },
      delete_data_table_column: { dataTableId: crypto.randomUUID(), columnId: crypto.randomUUID() },
      delete_data_table_rows: {
        dataTableId: crypto.randomUUID(),
        filter: { type: 'and', filters: [{ columnName: 'a', condition: 'eq', value: 1 }] },
      },
    };
    for (const name of irreversible) {
      const tool = dataTablesTools.find((t) => t.name === name);
      expect(tool?.grantKey?.(sample[name]), `${name} grant key`).toBeNull();
    }
  });

  it('reads: a viewer lists, reads the schema and filters rows; the text is wrapped and the schema sets an artifact', async () => {
    const table = await makeTable([
      { name: 'Alice', qty: 1 },
      { name: 'Bob', qty: 2 },
    ]);
    const listed = await h.callTool(h.viewer, 'list_data_tables', { query: table.name });
    expect(listed.status.isSuspended).toBe(false);
    expect(listed.result).toContain('source="data-tables"');
    expect(listed.result).toContain(table.id);

    const schema = await h.callTool(h.viewer, 'get_data_table_schema', { dataTableId: table.id });
    expect(schema.result).toContain('"name":"qty"');
    const events = await eventsOf(h.viewer, schema.threadId);
    const artifact = events.find((e) => e.type === 'artifact');
    expect(artifact?.payload).toMatchObject({ artifact: { type: 'data-table', id: table.id, name: table.name } });

    // like keeps the service's rule: a value without % matches anywhere in the text
    const rows = await h.callTool(h.viewer, 'query_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [{ columnName: 'name', condition: 'like', value: 'lic' }] },
    });
    expect(rows.result).toContain('Alice');
    expect(rows.result).not.toContain('Bob');
    expect(rows.result).toContain('"count":1');
    const rowEvents = await eventsOf(h.viewer, rows.threadId);
    expect(rowEvents.some((e) => e.type === 'artifact')).toBe(true);
  });

  it('create_data_table: a card with the columns, nothing yet, then the table exists and an artifact event is sent', async () => {
    const name = `made_${suffix()}`;
    const columns = ['a', 'b', 'c', 'd', 'e'].map((column) => ({ name: column, type: 'string' }));
    const { turn, card } = await cardFor(h.editor, 'create_data_table', { name, columns });
    expect(card.toolName).toBe('create_data_table');
    expect(card.allowSession).toBe(true);
    expect(card.details.facts).toEqual([
      { label: 'Name', value: name },
      { label: 'Columns', value: '5' },
    ]);
    expect(card.details.preview).toMatchObject({
      columns: ['Column', 'Type'],
      rows: [
        ['a', 'string'],
        ['b', 'string'],
        ['c', 'string'],
      ],
      omittedRows: 2,
    });
    const before = await h.owner.client.data<{ data: Array<{ name: string }> }>(
      h.owner.client.get('/rest/data-tables?take=250'),
    );
    expect(before.data.some((t) => t.name === name)).toBe(false);

    const result = await approveCard(h.editor, turn, card);
    expect(JSON.parse(result)).toMatchObject({ name });
    const after = await h.owner.client.data<{ data: Array<{ id: string; name: string }> }>(
      h.owner.client.get('/rest/data-tables?take=250'),
    );
    const made = after.data.find((t) => t.name === name);
    expect(made).toBeDefined();
    const events = await eventsOf(h.editor, turn.threadId);
    expect(events.find((e) => e.type === 'artifact')?.payload).toMatchObject({
      artifact: { type: 'data-table', id: made?.id, name },
    });
  });

  it('a viewer cannot create or change: the write tools are not offered and nothing waits', async () => {
    const name = `nope_${suffix()}`;
    const table = await makeTable([{ name: 'Keep', qty: 1 }]);
    for (const [tool, args] of [
      ['create_data_table', { name, columns: [] }],
      ['insert_data_table_rows', { dataTableId: table.id, rows: [{ name: 'X', qty: 1 }] }],
      ['delete_data_table', { dataTableId: table.id }],
    ] as const) {
      const turn = await h.callTool(h.viewer, tool, args);
      expect(turn.status.isSuspended, tool).toBe(false);
      expect(turn.status.pending, tool).toEqual([]);
    }
    const names = await h.owner.client.data<{ data: Array<{ name: string }> }>(
      h.owner.client.get('/rest/data-tables?take=250'),
    );
    expect(names.data.some((t) => t.name === name)).toBe(false);
    expect((await rowsOf(table.id)).count).toBe(1);
  });

  it('insert_data_table_rows: a card previews the rows, then the rows exist', async () => {
    const table = await makeTable();
    const rows = [1, 2, 3, 4, 5].map((n) => ({ name: `row${n}`, qty: n }));
    const { turn, card } = await cardFor(h.editor, 'insert_data_table_rows', {
      dataTableId: table.id,
      rows,
    });
    expect(card.resourceName).toBe(table.name);
    expect(card.details.facts).toEqual([
      { label: 'Table', value: table.name },
      { label: 'Rows to insert', value: '5' },
    ]);
    expect(card.details.preview).toEqual({
      columns: ['name', 'qty'],
      rows: [
        ['row1', '1'],
        ['row2', '2'],
        ['row3', '3'],
      ],
      omittedRows: 2,
      omittedColumns: 0,
    });
    expect((await rowsOf(table.id)).count).toBe(0);
    const result = await approveCard(h.editor, turn, card);
    expect(JSON.parse(result)).toEqual({ insertedRows: 5 });
    const after = await rowsOf(table.id);
    expect(after.data.map((r) => r.name).sort()).toEqual(['row1', 'row2', 'row3', 'row4', 'row5']);
  });

  it('update_data_table_rows: the card states the matches and the change; the change applies after the approval', async () => {
    const table = await makeTable([
      { name: 'a', qty: 1 },
      { name: 'b', qty: 1 },
      { name: 'c', qty: 9 },
    ]);
    const { turn, card } = await cardFor(h.editor, 'update_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [{ columnName: 'qty', condition: 'eq', value: 1 }] },
      data: { qty: 5 },
    });
    expect(card.details.facts).toEqual([
      { label: 'Table', value: table.name },
      { label: 'Rows that match', value: '2' },
      { label: 'Condition', value: 'qty eq 1' },
      { label: 'Set', value: 'qty = 5' },
    ]);
    expect(card.details.preview?.rows).toHaveLength(2);
    expect((await rowsOf(table.id)).data.filter((r) => r.qty === 5)).toHaveLength(0);
    const result = await approveCard(h.editor, turn, card);
    expect(JSON.parse(result)).toEqual({ updatedRows: 2 });
    expect((await rowsOf(table.id)).data.filter((r) => r.qty === 5)).toHaveLength(2);
  });

  it('update with an empty filter is refused before any card', async () => {
    const table = await makeTable([{ name: 'a', qty: 1 }]);
    const turn = await h.callTool(h.editor, 'update_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [] },
      data: { qty: 0 },
    });
    expect(turn.status.pending).toEqual([]);
    expect(turn.result).toContain('Filter is required');
    expect((await rowsOf(table.id)).data[0].qty).toBe(1);
  });

  it('delete_data_table_rows: an empty filter is refused with no card; the card shows three rows and the omitted count; no session button', async () => {
    const table = await makeTable([1, 2, 3, 4, 5].map((n) => ({ name: `r${n}`, qty: n })));
    const empty = await h.callTool(h.editor, 'delete_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [] },
    });
    expect(empty.status.pending).toEqual([]);
    expect(empty.result).toContain('Filter is required for delete operations');
    expect((await rowsOf(table.id)).count).toBe(5);

    const { turn, card } = await cardFor(h.editor, 'delete_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [{ columnName: 'qty', condition: 'gte', value: 1 }] },
    });
    expect(card.allowSession).toBe(false);
    expect(card.details.facts[1]).toEqual({ label: 'Rows that will be deleted', value: '5' });
    expect(card.details.preview?.rows).toHaveLength(3);
    expect(card.details.preview?.omittedRows).toBe(2);
    expect((await rowsOf(table.id)).count).toBe(5);
    const result = await approveCard(h.editor, turn, card);
    expect(JSON.parse(result)).toEqual({ deletedRows: 5 });
    expect((await rowsOf(table.id)).count).toBe(0);
  });

  it('columns: add and rename after an approval; delete a column has no session button', async () => {
    const table = await makeTable([{ name: 'a', qty: 1 }]);
    const add = await cardFor(h.editor, 'add_data_table_column', {
      dataTableId: table.id,
      name: 'note',
      type: 'string',
    });
    expect(add.card.allowSession).toBe(true);
    expect(add.card.details.facts).toContainEqual({ label: 'Column', value: 'note' });
    const added = JSON.parse(await approveCard(h.editor, add.turn, add.card));
    expect(added).toMatchObject({ name: 'note', type: 'string' });

    const rename = await cardFor(h.editor, 'rename_data_table_column', {
      dataTableId: table.id,
      columnId: added.id,
      name: 'comment',
    });
    expect(rename.card.details.facts).toContainEqual({ label: 'New name', value: 'comment' });
    expect(JSON.parse(await approveCard(h.editor, rename.turn, rename.card))).toMatchObject({ name: 'comment' });

    const drop = await cardFor(h.editor, 'delete_data_table_column', {
      dataTableId: table.id,
      columnId: added.id,
    });
    expect(drop.card.allowSession).toBe(false);
    expect(drop.card.details.facts).toContainEqual({ label: 'Column', value: 'comment' });
    expect(JSON.parse(await approveCard(h.editor, drop.turn, drop.card))).toMatchObject({ deleted: true });
    const info = await h.owner.client.data<{ columns: Array<{ name: string }> }>(
      h.owner.client.get(`/rest/data-tables/${table.id}`),
    );
    expect(info.columns.map((c) => c.name)).toEqual(['name', 'qty']);
  });

  it('delete_data_table: a card with the row count, no session button, an audit row after the approval', async () => {
    const table = await makeTable([{ name: 'a', qty: 1 }]);
    const { turn, card } = await cardFor(h.editor, 'delete_data_table', { dataTableId: table.id });
    expect(card.allowSession).toBe(false);
    expect(card.resourceName).toBe(table.name);
    expect(card.details.facts).toContainEqual({ label: 'Rows that will be lost', value: '1' });
    const result = await approveCard(h.editor, turn, card);
    expect(JSON.parse(result)).toMatchObject({ deleted: true });
    const gone = await h.owner.client.get(`/rest/data-tables/${table.id}`);
    expect(gone.statusCode).toBe(404);
    const audit = await h.ctx.repos.audit.list(h.tenantId, 200);
    const row = audit.find((r) => r.action === 'dataTable.deleted' && r.resourceId === table.id);
    expect(row?.userId).toBe(h.editor.userId);
  });

  it("another workspace's table is refused by every tool, with no card", async () => {
    const foreign = h.other.dataTableId;
    const columnId = crypto.randomUUID();
    const filter = { type: 'and', filters: [{ columnName: 'secret', condition: 'eq', value: 'x' }] };
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_data_table_schema', { dataTableId: foreign }],
      ['query_data_table_rows', { dataTableId: foreign }],
      ['delete_data_table', { dataTableId: foreign }],
      ['add_data_table_column', { dataTableId: foreign, name: 'x', type: 'string' }],
      ['delete_data_table_column', { dataTableId: foreign, columnId }],
      ['rename_data_table_column', { dataTableId: foreign, columnId, name: 'y' }],
      ['insert_data_table_rows', { dataTableId: foreign, rows: [{ secret: 'x' }] }],
      ['update_data_table_rows', { dataTableId: foreign, filter, data: { secret: 'y' } }],
      ['delete_data_table_rows', { dataTableId: foreign, filter }],
    ];
    for (const [tool, args] of calls) {
      const turn = await h.callTool(h.owner, tool, args);
      expect(turn.status.pending, `${tool} shows no card`).toEqual([]);
      expect(turn.result, `${tool} is refused`).toContain('could not be found');
    }
    const listed = await h.callTool(h.owner, 'list_data_tables', { limit: 100 });
    expect(listed.result).not.toContain(foreign);
    // the id appears because the model asked for it; nothing else of the other workspace does
    const sent = JSON.stringify(h.fake.requests);
    for (const value of [CANARY.dataTable, CANARY.workspace, CANARY.workflow, CANARY.secret, h.other.tenantId]) {
      expect(sent, `${value} reached the model`).not.toContain(value);
    }
    // the other workspace's table is untouched
    const rows = await h.other.owner.client.data<{ count: number }>(
      h.other.owner.client.get(`/rest/data-tables/${foreign}/rows`),
    );
    expect(rows.count).toBe(0);
  });

  it('a secret in a cell is redacted in the result and never reaches a request to the model unredacted', async () => {
    const secret = 'sk-proj-SeededSecret0123456789abcdefXYZ';
    const table = await makeTable([{ name: secret, qty: 1 }]);
    const turn = await h.callTool(h.viewer, 'query_data_table_rows', { dataTableId: table.id });
    expect(turn.result).not.toContain(secret);
    expect(JSON.stringify(h.fake.requests)).not.toContain(secret);
    const events = await eventsOf(h.viewer, turn.threadId);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
