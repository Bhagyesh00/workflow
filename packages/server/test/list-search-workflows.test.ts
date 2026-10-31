import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, createWorkflow, node, resetDatabase, signup, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

type Page = { results: Array<{ name: string; value: string; url?: string }>; paginationToken?: string };

async function search(
  client: Awaited<ReturnType<typeof signup>>['client'],
  extra: { filter?: string; paginationToken?: string; workflowId?: string } = {},
): Promise<Page> {
  return client.data<Page>(
    client.post('/rest/node-types/options', {
      nodeType: 'core.executeWorkflow',
      method: 'searchWorkflows',
      kind: 'listSearch',
      node: node('Execute Workflow', 'core.executeWorkflow', { source: 'database' }),
      ...extra,
    }),
  );
}

const trigger = () => [node('Start', 'core.manualTrigger')];

describe('Execute Workflow listSearch searchWorkflows', () => {
  it('lists the tenant workflows with id values and editor urls', async () => {
    const { client } = await signup(server.app);
    const a = await createWorkflow(client, { name: 'Send invoices', nodes: trigger() });
    await createWorkflow(client, { name: 'Sync contacts', nodes: trigger() });

    const page = await search(client);
    expect(page.results.map((r) => r.name).sort()).toEqual(['Send invoices', 'Sync contacts']);
    expect(page.paginationToken).toBeUndefined();
    const hit = page.results.find((r) => r.value === a.id);
    expect(hit?.name).toBe('Send invoices');
    expect(hit?.url).toMatch(new RegExp(`/workflow/${a.id}$`));
  });

  it('filters by name, case-insensitively and treating % literally', async () => {
    const { client } = await signup(server.app);
    await createWorkflow(client, { name: 'Send invoices', nodes: trigger() });
    await createWorkflow(client, { name: 'Sync contacts', nodes: trigger() });
    await createWorkflow(client, { name: '100% done', nodes: trigger() });

    expect((await search(client, { filter: 'INVOICE' })).results.map((r) => r.name)).toEqual([
      'Send invoices',
    ]);
    expect((await search(client, { filter: '%' })).results.map((r) => r.name)).toEqual(['100% done']);
    expect((await search(client, { filter: 'nothing like it' })).results).toEqual([]);
  });

  it('never returns another tenant workflow', async () => {
    const mine = await signup(server.app);
    const theirs = await signup(server.app);
    await createWorkflow(mine.client, { name: 'Mine', nodes: trigger() });
    const other = await createWorkflow(theirs.client, { name: 'Theirs', nodes: trigger() });

    const page = await search(mine.client);
    expect(page.results.map((r) => r.name)).toEqual(['Mine']);
    expect(page.results.some((r) => r.value === other.id)).toBe(false);
    expect((await search(mine.client, { filter: 'Theirs' })).results).toEqual([]);
  });

  it('leaves out the workflow being edited when the editor sends its id', async () => {
    const { client } = await signup(server.app);
    const self = await createWorkflow(client, { name: 'Self', nodes: trigger() });
    await createWorkflow(client, { name: 'Other', nodes: trigger() });

    const page = await search(client, { workflowId: self.id });
    expect(page.results.map((r) => r.name)).toEqual(['Other']);
    expect((await search(client)).results).toHaveLength(2);
  });

  it('pages with a token, without gaps or repeats, also when the edited workflow is on a page', async () => {
    const { client, tenant } = await signup(server.app);
    const total = 120;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const id = randomUUID();
      ids.push(id);
      await server.ctx.repos.workflows.create(tenant.id, {
        id,
        versionId: randomUUID(),
        name: `Flow ${String(i).padStart(3, '0')}`,
        nodes: [],
        connections: {},
        settings: {},
        pinData: {},
        stickyNotes: [],
      });
    }
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await search(client, { paginationToken: token, workflowId: ids[5] });
      expect(page.results.length).toBeLessThanOrEqual(50);
      seen.push(...page.results.map((r) => r.value));
      token = page.paginationToken;
      pages++;
    } while (token && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(ids.filter((id) => id !== ids[5]).sort());
  });

  it('rejects a garbage pagination token', async () => {
    const { client } = await signup(server.app);
    const res = await client.post('/rest/node-types/options', {
      nodeType: 'core.executeWorkflow',
      method: 'searchWorkflows',
      kind: 'listSearch',
      node: node('Execute Workflow', 'core.executeWorkflow'),
      paginationToken: 'not-a-token',
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['a value that is not a date', ['x', '00000000-0000-0000-0000-000000000000']],
    ['an id that is not a uuid', [new Date().toISOString(), 'not-a-uuid']],
  ])('rejects a well-formed pagination token with %s', async (_label, parts) => {
    const { client } = await signup(server.app);
    const res = await client.post('/rest/node-types/options', {
      nodeType: 'core.executeWorkflow',
      method: 'searchWorkflows',
      kind: 'listSearch',
      node: node('Execute Workflow', 'core.executeWorkflow'),
      paginationToken: Buffer.from(JSON.stringify(parts)).toString('base64url'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid cursor');
    expect(res.body).not.toContain('timestamp');
  });
});
