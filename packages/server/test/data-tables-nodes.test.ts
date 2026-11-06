/**
 * P4-04 Data Table node on the real server and database. Done when: rows written by one workflow are
 * read by another (POST /rest/workflows/:id/run), another workspace gets n8n's not-found text, and a
 * table is found by its exact name.
 */
import { DATA_TABLE_ERRORS } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup as signupFrom,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
const signup = () =>
  signupFrom(server.app, {
    remoteAddress: `10.6.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
type Owner = Awaited<ReturnType<typeof signup>>;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const locator = (mode: 'id' | 'name', value: string) => ({ __rl: true, mode, value });

async function makeTable(owner: Owner, name = 'Orders') {
  return owner.client.data<{ id: string; name: string }>(
    owner.client.post('/rest/data-tables', {
      name,
      columns: [
        { name: 'title', type: 'string' },
        { name: 'qty', type: 'number' },
      ],
    }),
  );
}

/** a Manual Trigger followed by one Data Table node, run through the workflow route */
async function runTableNode(owner: Owner, parameters: Record<string, unknown>, input?: unknown[]) {
  const wf = await createWorkflow(owner.client, {
    nodes: [node('Start', 'core.manualTrigger'), node('Table', 'core.dataTable', parameters, [200, 0])],
    connections: chain('Start', 'Table'),
  });
  const { executionId } = await owner.client.data<{ executionId: string }>(
    owner.client.post(`/rest/workflows/${wf.id}/run`, input ? { triggerItems: input } : {}),
  );
  const row = await waitForExecution(server.ctx, owner.tenant.id, executionId);
  const execution = await owner.client.data<{ state: any }>(owner.client.get(`/rest/executions/${executionId}`));
  const result = execution.state.resultData;
  return {
    status: row.status,
    error: result.error?.message as string | undefined,
    description: result.error?.description as string | undefined,
    json: (result.runData.Table?.[0]?.data?.main?.[0] ?? []).map((i: any) => i.json) as any[],
  };
}

describe('Data Table node on the server', () => {
  it('rows written by one workflow are read by another', async () => {
    const owner = await signup();
    const table = await makeTable(owner);

    const written = await runTableNode(
      owner,
      {
        resource: 'row',
        operation: 'insert',
        dataTableId: locator('id', table.id),
        dataMode: 'autoMapInputData',
      },
      [{ json: { title: 'first', qty: 2 } }, { json: { title: 'second', qty: '5' } }],
    );
    expect(written.status).toBe('success');
    expect(written.json).toMatchObject([
      { id: 1, title: 'first', qty: 2 },
      { id: 2, title: 'second', qty: 5 },
    ]);

    // another workflow, the table picked by its name
    const read = await runTableNode(owner, {
      resource: 'row',
      operation: 'get',
      dataTableId: locator('name', 'Orders'),
      returnAll: true,
      orderBy: true,
      orderByColumn: 'qty',
      orderByDirection: 'DESC',
      filters: { conditions: [{ keyName: 'qty', condition: 'gte', keyValue: '2' }] },
    });
    expect(read.status).toBe('success');
    expect(read.json.map((r) => [r.title, r.qty])).toEqual([
      ['second', 5],
      ['first', 2],
    ]);

    // the REST side sees the same rows
    const viaRest = await owner.client.data<{ count: number }>(
      owner.client.get(`/rest/data-tables/${table.id}/rows?take=250`),
    );
    expect(viaRest.count).toBe(2);
  });

  it('updates, upserts, checks existence and deletes through the node', async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    const base = { resource: 'row', dataTableId: locator('id', table.id) };
    const where = (title: string) => ({ conditions: [{ keyName: 'title', condition: 'eq', keyValue: title }] });
    const fields = (title: string, qty: string) => ({
      fieldValues: [
        { columnName: 'title', value: title },
        { columnName: 'qty', value: qty },
      ],
    });

    const upsert = (title: string, qty: string) =>
      runTableNode(owner, {
        ...base,
        operation: 'upsert',
        dataMode: 'defineBelow',
        fieldsUi: fields(title, qty),
        filters: where(title),
      });
    expect((await upsert('a', '1')).json).toMatchObject([{ title: 'a', qty: 1 }]);
    expect((await upsert('a', '4')).json).toMatchObject([{ id: 1, title: 'a', qty: 4 }]);

    const dry = await runTableNode(owner, {
      ...base,
      operation: 'update',
      dataMode: 'defineBelow',
      fieldsUi: fields('a', '9'),
      filters: where('a'),
      options: { dryRun: true },
    });
    expect(dry.json.map((r) => [r.dryRunState, r.qty])).toEqual([
      ['before', 4],
      ['after', 9],
    ]);

    const exists = await runTableNode(owner, { ...base, operation: 'rowExists', filters: where('a') }, [
      { json: { k: 1 } },
    ]);
    expect(exists.json).toEqual([{ k: 1 }]);
    const missing = await runTableNode(owner, { ...base, operation: 'rowExists', filters: where('zz') });
    expect(missing.json).toEqual([]);

    const noFilter = await runTableNode(owner, { ...base, operation: 'deleteRows' });
    expect(noFilter.status).toBe('error');
    expect(noFilter.error).toBe(DATA_TABLE_ERRORS.atLeastOneCondition);

    const removed = await runTableNode(owner, { ...base, operation: 'deleteRows', filters: where('a') });
    expect(removed.json).toMatchObject([{ title: 'a', qty: 4 }]);
    const left = await owner.client.data<{ count: number }>(
      owner.client.get(`/rest/data-tables/${table.id}/rows?take=250`),
    );
    expect(left.count).toBe(0);
  });

  it('creates, lists, renames, clears and deletes tables', async () => {
    const owner = await signup();
    const created = await runTableNode(owner, {
      resource: 'table',
      operation: 'create',
      tableName: 'Fresh',
      columns: { column: [{ name: 'note', type: 'string' }] },
    });
    expect(created.json[0]).toMatchObject({ name: 'Fresh', columns: [{ name: 'note', type: 'string' }] });
    const again = await runTableNode(owner, {
      resource: 'table',
      operation: 'create',
      tableName: 'Fresh',
      columns: { column: [] },
    });
    expect(again.json[0]!.id).toBe(created.json[0]!.id);
    const strict = await runTableNode(owner, {
      resource: 'table',
      operation: 'create',
      tableName: 'Fresh',
      columns: { column: [] },
      options: { createIfNotExists: false },
    });
    expect(strict.error).toBe(DATA_TABLE_ERRORS.tableNameExists('Fresh'));

    const id = created.json[0]!.id as string;
    const ref = { dataTableId: locator('id', id) };
    expect((await runTableNode(owner, { resource: 'table', operation: 'list', returnAll: true })).json).toHaveLength(1);
    expect((await runTableNode(owner, { resource: 'table', operation: 'update', newName: 'Renamed', ...ref })).json).toEqual([
      { success: true, name: 'Renamed' },
    ]);
    expect((await runTableNode(owner, { resource: 'table', operation: 'clear', ...ref })).json).toEqual([
      { success: true, deletedCount: 0 },
    ]);
    expect((await runTableNode(owner, { resource: 'table', operation: 'deleteTable', ...ref })).json).toEqual([
      { success: true, deletedTableId: id },
    ]);
  });

  it("answers another workspace's table id with n8n's not-found text, and a part of a name finds nothing", async () => {
    const mine = await signup();
    const theirs = await signup();
    const table = await makeTable(mine);

    const byId = await runTableNode(theirs, {
      resource: 'row',
      operation: 'get',
      dataTableId: locator('id', table.id),
    });
    expect(byId.status).toBe('error');
    expect(byId.error).toBe(DATA_TABLE_ERRORS.tableIdNotFound(table.id));
    expect(byId.description).toBe(DATA_TABLE_ERRORS.tableIdNotFoundDescription);

    const byName = await runTableNode(theirs, {
      resource: 'row',
      operation: 'get',
      dataTableId: locator('name', 'Orders'),
    });
    expect(byName.error).toBe(DATA_TABLE_ERRORS.tableNameNotFound('Orders'));

    const part = await runTableNode(mine, {
      resource: 'row',
      operation: 'get',
      dataTableId: locator('name', 'Order'),
    });
    expect(part.error).toBe(DATA_TABLE_ERRORS.tableNameNotFound('Order'));
  });

  it("lists the workspace's tables and columns for the editor", async () => {
    const owner = await signup();
    const table = await makeTable(owner);
    await makeTable(await signup(), 'Not mine');
    const search = await owner.client.data<{ results: Array<{ name: string; value: string; url?: string }> }>(
      owner.client.post('/rest/node-types/options', {
        nodeType: 'core.dataTable',
        kind: 'listSearch',
        method: 'tableSearch',
        node: { id: 'n', name: 'Table', type: 'core.dataTable', typeVersion: 1, position: [0, 0], parameters: {} },
        filter: 'ord',
      }),
    );
    expect(search.results).toEqual([{ name: 'Orders', value: table.id, url: `/data-tables/${table.id}` }]);

    const columns = await owner.client.data<Array<{ value: string }>>(
      owner.client.post('/rest/node-types/options', {
        nodeType: 'core.dataTable',
        kind: 'loadOptions',
        method: 'getColumns',
        node: {
          id: 'n',
          name: 'Table',
          type: 'core.dataTable',
          typeVersion: 1,
          position: [0, 0],
          parameters: { dataTableId: locator('id', table.id) },
        },
      }),
    );
    expect(columns.map((c) => c.value)).toEqual(['title', 'qty', 'id', 'createdAt', 'updatedAt']);
  });
});
