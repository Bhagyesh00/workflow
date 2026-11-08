import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  hookRegistry,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  hookRegistry.length = 0;
});

const webhook = (parameters: Record<string, unknown>, webhookId = 'hook-id') =>
  node('Webhook', 'core.webhook', { httpMethod: 'POST', ...parameters }, [0, 0], { webhookId });

async function activeWorkflow(
  client: Awaited<ReturnType<typeof signup>>['client'],
  definition: Parameters<typeof createWorkflow>[1],
) {
  const wf = await createWorkflow(client, definition);
  const activated = await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  expect(activated.active).toBe(true);
  return wf;
}

describe('production webhooks', () => {
  it('responds immediately in onReceived mode and runs the workflow', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        webhook({ path: 'orders/new', responseCode: 202 }),
        setNode('Set', 'total', '={{ $json.body.qty * 2 }}'),
      ],
      connections: chain('Webhook', 'Set'),
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/orders/new?source=test`,
      payload: { qty: 21 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ message: 'Workflow was started' });
    // tenant-controlled responses are sandboxed
    expect(res.headers['content-security-policy']).toMatch(/^sandbox/);

    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${execution.id}`));
    expect(data.mode).toBe('webhook');
    const [item] = outputOf(data.state, 'Set');
    expect(item).toMatchObject({ body: { qty: 21 }, query: { source: 'test' }, total: '42' });

    expect(
      (await server.app.inject({ method: 'GET', url: `/webhook/${tenant.slug}/orders/new` })).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ method: 'POST', url: '/webhook/unknown-tenant/orders/new' })).statusCode,
    ).toBe(404);
  });

  it('answers with the last node data in lastNode mode', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWorkflow(client, {
      nodes: [
        webhook({ path: 'calc', responseMode: 'lastNode', responseData: 'firstEntryJson' }),
        node(
          'Code',
          'core.code',
          {
            mode: 'runOnceForAllItems',
            jsCode:
              'return [{ json: { sum: items[0].json.body.a + items[0].json.body.b } }, { json: { second: true } }];',
          },
          [200, 0],
        ),
      ],
      connections: chain('Webhook', 'Code'),
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/calc`,
      payload: { a: 2, b: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sum: 5 });

    const all = await createWorkflow(client, {
      nodes: [
        webhook({ path: 'all', responseMode: 'lastNode', responseData: 'allEntries' }, 'hook-2'),
        node(
          'Code',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: 'return [{ json: { i: 1 } }, { json: { i: 2 } }];' },
          [200, 0],
        ),
      ],
      connections: chain('Webhook', 'Code'),
    });
    await client.data(client.post(`/rest/workflows/${all.id}/activate`));
    const list = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/all` });
    expect(list.json()).toEqual([{ i: 1 }, { i: 2 }]);

    const failing = await createWorkflow(client, {
      nodes: [
        webhook({ path: 'boom', responseMode: 'lastNode' }, 'hook-3'),
        node('Boom', 'test.fail', {}, [200, 0]),
      ],
      connections: chain('Webhook', 'Boom'),
    });
    await client.data(client.post(`/rest/workflows/${failing.id}/activate`));
    const boom = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/boom` });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: { code: 'workflow_error', message: 'Error in workflow' } });
  });

  it('holds the request until the Respond to Webhook node answers in responseNode mode', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        webhook({ path: 'respond', responseMode: 'responseNode' }),
        node(
          'Respond',
          'core.respondToWebhook',
          {
            respondWith: 'json',
            responseBody: '={{ JSON.stringify({ id: $json.body.id, ok: true }) }}',
            options: { responseCode: 201, responseHeaders: '{"X-Custom":"yes"}' },
          },
          [200, 0],
        ),
        node('After', 'test.sleep', { ms: 300 }, [400, 0]),
      ],
      connections: chain('Webhook', 'Respond', 'After'),
    });
    const started = Date.now();
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/respond`,
      payload: { id: 9 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 9, ok: true });
    expect(res.headers['x-custom']).toBe('yes');
    // answered before the rest of the workflow finished
    expect(Date.now() - started).toBeLessThan(300);
    const [execution] = await executionsOf(server.ctx, tenant.id, wf.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);

    // activation refuses responseNode mode without a Respond to Webhook node
    const invalid = await createWorkflow(client, {
      nodes: [webhook({ path: 'nothing', responseMode: 'responseNode' }, 'hook-x')],
    });
    const failed = await client.post(`/rest/workflows/${invalid.id}/activate`);
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error.details[0].message).toMatch(/Respond to Webhook/);
  });

  it('streams chunks sent by nodes as NDJSON in streaming mode', async () => {
    const { client, tenant } = await signup(server.app);
    const stream = node('Stream', 'test.chunks', { text: '={{ $json.body.text }}' }, [200, 0]);
    await activeWorkflow(client, {
      nodes: [webhook({ path: 'chat', responseMode: 'streaming' }), stream],
      connections: chain('Webhook', 'Stream'),
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/chat`,
      payload: { text: 'one two three' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // every frame names the node run that sent it (n8n's chunk metadata)
    const metadata = {
      nodeId: stream.id,
      nodeName: 'Stream',
      runIndex: 0,
      itemIndex: 0,
      timestamp: expect.any(Number),
    };
    expect(lines).toEqual([
      { type: 'begin', metadata },
      { type: 'item', content: 'one', metadata },
      { type: 'item', content: 'two', metadata },
      { type: 'item', content: 'three', metadata },
      { type: 'end', metadata },
    ]);
  });

  it('matches dynamic paths after static ones and passes route params', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWorkflow(client, {
      nodes: [webhook({ path: 'users/:id', httpMethod: 'GET', responseMode: 'lastNode' }, 'dyn')],
    });
    const staticWf = await createWorkflow(client, {
      nodes: [webhook({ path: 'users/me', httpMethod: 'GET', responseMode: 'lastNode' }, 'static')],
    });
    await client.data(client.post(`/rest/workflows/${staticWf.id}/activate`));
    const dynamic = await server.app.inject({ url: `/webhook/${tenant.slug}/users/42` });
    expect(dynamic.json().params).toEqual({ id: '42' });
    const me = await server.app.inject({ url: `/webhook/${tenant.slug}/users/me` });
    expect(me.json().params).toEqual({});

    // a differently named parameter in the same position would be ambiguous
    const ambiguous = await createWorkflow(client, {
      nodes: [webhook({ path: 'users/:userId', httpMethod: 'GET' }, 'ambiguous')],
    });
    const refused = await client.post(`/rest/workflows/${ambiguous.id}/activate`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details[0].message).toMatch(/already used/);
  });

  it('checks webhook authentication, handles multipart uploads and never forwards the session cookie', async () => {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'hdr',
        type: 'httpHeaderAuth',
        data: { name: 'x-token', value: 's3cret' },
      }),
    );
    await activeWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'secure', authentication: 'headerAuth', responseMode: 'lastNode' },
          [0, 0],
          { webhookId: 'sec', credentials: { httpHeaderAuth: { id: credential.id, name: 'hdr' } } },
        ),
      ],
    });
    const denied = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/secure`,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    const boundary = 'XBOUNDARY';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'Report',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="hello.txt"',
      'Content-Type: text/plain',
      '',
      'hello world',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/secure`,
      headers: {
        'x-token': 's3cret',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: 'wf_session=stolen-token; theme=dark',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.body).toEqual({ title: 'Report' });
    expect(json.headers.cookie).toBe('theme=dark');
    const [execution] = await executionsOf(server.ctx, tenant.id);
    const data = await client.data(client.get(`/rest/executions/${execution.id}`));
    const item = data.state.resultData.runData.Webhook[0].data.main[0][0];
    expect(item.binary.data).toMatchObject({ fileName: 'hello.txt', mimeType: 'text/plain' });
    expect(Buffer.from(item.binary.data.data, 'base64').toString()).toBe('hello world');
  });

  it('stores large uploads on disk and serves them only to the owning tenant', async () => {
    const { client, tenant } = await signup(server.app);
    const other = await signup(server.app);
    await activeWorkflow(client, { nodes: [webhook({ path: 'upload' })] });
    const boundary = 'B0UNDARY';
    const big = 'x'.repeat(100_000);
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="page.html"',
        'Content-Type: text/html',
        '',
        `<script>alert(1)</script>${big}`,
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    expect(res.statusCode).toBe(200);
    const [execution] = await executionsOf(server.ctx, tenant.id);
    await waitForExecution(server.ctx, tenant.id, execution.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${execution.id}`));
    const binary = data.state.resultData.runData.Webhook[0].data.main[0][0].binary.data;
    expect(binary.id).toMatch(new RegExp(`^fs:${tenant.id}/${execution.id}/`));
    expect(binary.data).toBe('');

    const query = `id=${encodeURIComponent(binary.id)}&mimeType=text/html&fileName=page.html`;
    const own = await client.get(`/rest/binary-data?${query}`);
    expect(own.statusCode).toBe(200);
    expect(own.body.length).toBe(binary.fileSize);
    // HTML is never rendered inline on the platform origin
    expect(own.headers['content-disposition']).toMatch(/^attachment/);
    expect(own.headers['content-security-policy']).toBe('sandbox');
    expect((await other.client.get(`/rest/binary-data?${query}`)).statusCode).toBe(404);
    const traversal = `id=${encodeURIComponent(`fs:${tenant.id}/../${other.tenant.id}/x`)}`;
    expect((await client.get(`/rest/binary-data?${traversal}`)).statusCode).toBe(404);

    // deleting the execution removes its files
    await client.data(client.delete(`/rest/executions/${execution.id}`));
    expect((await client.get(`/rest/binary-data?${query}`)).statusCode).toBe(404);
  });

  it('keeps the raw body and rejects malformed JSON', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWorkflow(client, {
      nodes: [webhook({ path: 'raw', responseMode: 'lastNode', options: { rawBody: true } })],
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/raw`,
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1,"__proto__":{"polluted":true}}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ a: 1 });
    const bad = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/raw`,
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('deduplicates deliveries carrying an Idempotency-Key (platform extension)', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        webhook({ path: 'pay', responseMode: 'lastNode' }),
        setNode('Set', 'charged', '={{ $json.body.amount }}'),
      ],
      connections: chain('Webhook', 'Set'),
    });
    const call = () =>
      server.app.inject({
        method: 'POST',
        url: `/webhook/${tenant.slug}/pay`,
        headers: { 'idempotency-key': 'evt-1' },
        payload: { amount: 10 },
      });
    const first = await call();
    const second = await call();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
    const other = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/pay`,
      headers: { 'idempotency-key': 'evt-2' },
      payload: { amount: 10 },
    });
    expect(other.headers['idempotency-replayed']).toBeUndefined();
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(2);
  });

  it('answers CORS preflight requests for registered paths', async () => {
    const { client, tenant } = await signup(server.app);
    await activeWorkflow(client, { nodes: [webhook({ path: 'cors' })] });
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: `/webhook/${tenant.slug}/cors`,
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    const call = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/cors`,
      headers: { origin: 'https://app.example.com' },
    });
    expect(call.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('activation', () => {
  it('registers and removes webhooks and re-registers them when a saved draft is published', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, { nodes: [webhook({ path: 'first' })] });
    const rows = await server.ctx.repos.webhooks.listForWorkflow(tenant.id, wf.id);
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(['POST first']);

    const urls = await client.data(client.get(`/rest/workflows/${wf.id}/webhook-urls`));
    expect(urls).toEqual([
      {
        nodeName: 'Webhook',
        method: 'POST',
        testUrl: `http://localhost:5678/webhook-test/${tenant.slug}/first`,
        productionUrl: `http://localhost:5678/webhook/${tenant.slug}/first`,
      },
    ]);

    // the same path cannot be used twice in one tenant
    const clash = await createWorkflow(client, { nodes: [webhook({ path: 'first' }, 'other')] });
    const refused = await client.post(`/rest/workflows/${clash.id}/activate`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details[0].message).toMatch(/already used/);

    // P3-10: a save writes the draft only; the published path keeps answering until the draft is published
    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        nodes: [webhook({ path: 'second' })],
      }),
    );
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/first` })).statusCode,
    ).toBe(200);
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/second` })).statusCode,
    ).toBe(404);
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/first` })).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/second` })).statusCode,
    ).toBe(200);

    const deactivated = await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    expect(deactivated.active).toBe(false);
    expect(await server.ctx.repos.webhooks.listForWorkflow(tenant.id, wf.id)).toEqual([]);
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/second` })).statusCode,
    ).toBe(404);

    const audit = await client.data(client.get('/rest/audit-log'));
    expect(audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['workflow.activated', 'workflow.deactivated']),
    );
  });

  it('registers third-party webhooks through webhookMethods and removes them on deactivation', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [node('Remote', 'test.hookRegister', {}, [0, 0], { webhookId: 'remote-hook' })],
    });
    expect(hookRegistry).toEqual([
      { action: 'create', url: `http://localhost:5678/webhook/${tenant.slug}/remote-hook/events` },
    ]);
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    expect(row?.staticData).toEqual({ 'node:Remote': { remoteId: 'remote-1' } });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/remote-hook/events`,
      payload: { kind: 'ping' },
    });
    expect(res.statusCode).toBe(200);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    expect(hookRegistry.map((h) => h.action)).toEqual(['create', 'delete']);
  });

  it('runs schedule triggers and stops them on deactivation', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        node('Schedule', 'core.scheduleTrigger', {
          rule: { interval: [{ field: 'seconds', secondsInterval: 1 }] },
        }),
      ],
    });
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toContain(wf.id);
    const runs = await waitFor(
      async () => {
        const list = await executionsOf(server.ctx, tenant.id, wf.id);
        return list.length >= 1 && list;
      },
      { timeout: 4000, message: 'a scheduled execution' },
    );
    expect(runs[0].mode).toBe('trigger');
    await waitForExecution(server.ctx, tenant.id, runs[0].id, ['success']);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    expect(server.ctx.activeWorkflows.runningWorkflowIds).not.toContain(wf.id);
    await new Promise((r) => setTimeout(r, 200));
    const count = (await executionsOf(server.ctx, tenant.id, wf.id)).length;
    await new Promise((r) => setTimeout(r, 1300));
    expect((await executionsOf(server.ctx, tenant.id, wf.id)).length).toBe(count);
  });

  it('starts executions from trigger() emits and restores triggers on start-up', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        node('Interval', 'test.interval', { intervalMs: 100 }),
        setNode('Set', 'tick', '={{ $json.tick }}'),
      ],
      connections: chain('Interval', 'Set'),
    });
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id)).length >= 2, {
      message: 'two trigger executions',
    });
    // simulate a restart: the leader re-starts triggers of active workflows
    await server.ctx.activeWorkflows.stopAll();
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([]);
    await server.ctx.activeWorkflows.startAll();
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('polls on the configured schedule and persists static data after each poll', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await activeWorkflow(client, {
      nodes: [
        node('Poller', 'test.poll', { pollTimes: { item: [{ mode: 'everyX', unit: 'seconds', value: 1 }] } }),
      ],
    });
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id)).length >= 2, {
      timeout: 5000,
      message: 'two polls',
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    const count = (row!.staticData as { 'node:Poller': { count: number } })['node:Poller'].count;
    expect(count).toBeGreaterThanOrEqual(2);
    const executions = await executionsOf(server.ctx, tenant.id, wf.id);
    const last = executions[0];
    await waitForExecution(server.ctx, tenant.id, last.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${last.id}`));
    expect(outputOf(data.state, 'Poller')[0].count).toBe(executions.length);
  });

  it('enforces the monthly execution quota for production executions', async () => {
    const { client, tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { executionsPerMonth: 1 } });
    const wf = await activeWorkflow(client, { nodes: [webhook({ path: 'quota' })] });
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/quota` })).statusCode,
    ).toBe(200);
    const over = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/quota` });
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('plan_limit');
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
    // manual runs stay available for building workflows
    const manual = await client.post(`/rest/workflows/${wf.id}/run`, {});
    expect(manual.statusCode).toBe(200);
    const settings = await client.data(client.get('/rest/settings'));
    expect(settings.usage.executions).toBe(1);
    expect(settings.limits.executionsPerMonth).toBe(1);
  });

  it('enforces the active workflow plan limit', async () => {
    const { client, tenant } = await signup(server.app);
    await server.ctx.repos.tenants.updateSettings(tenant.id, { limits: { activeWorkflows: 1 } });
    await activeWorkflow(client, { nodes: [webhook({ path: 'one' }, 'one')] });
    const second = await createWorkflow(client, { nodes: [webhook({ path: 'two' }, 'two')] });
    const res = await client.post(`/rest/workflows/${second.id}/activate`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('plan_limit');
  });
});

describe('test webhooks', () => {
  it('listens once for a test call and runs the editor copy in manual mode', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [webhook({ path: 'try' })] });
    const unsaved = {
      name: 'Draft',
      nodes: [
        webhook({ path: 'try', responseMode: 'lastNode' }),
        setNode('Set', 'draft', true as unknown as string),
        node('Pinned', 'test.fail', {}, [400, 0]),
      ],
      connections: chain('Webhook', 'Set', 'Pinned'),
      // pinned output replaces the failing node in test runs
      pinData: { Pinned: [{ json: { pinned: true } }] },
    };
    const events: Array<{ type: string; data: any }> = [];
    const unsubscribe = await server.ctx.push.subscribe(tenant.id, (e) => events.push(e));
    try {
      const listen = await client.data(
        client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, {
          nodeName: 'Webhook',
          workflowData: unsaved,
        }),
      );
      expect(listen.testUrl).toBe(`http://localhost:5678/webhook-test/${tenant.slug}/try`);
      expect(new Date(listen.expiresAt).getTime()).toBeGreaterThan(Date.now() + 100_000);

      // production URL is not active
      expect(
        (await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/try` })).statusCode,
      ).toBe(404);
      const res = await server.app.inject({
        method: 'POST',
        url: `/webhook-test/${tenant.slug}/try`,
        payload: { x: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pinned: true });
      const second = await server.app.inject({ method: 'POST', url: `/webhook-test/${tenant.slug}/try` });
      expect(second.statusCode).toBe(404);

      const received = await waitFor(async () => events.find((e) => e.type === 'testWebhookReceived'));
      expect(received.data.workflowId).toBe(wf.id);
      const execution = await server.ctx.repos.executions.get(tenant.id, received.data.executionId);
      expect(execution?.mode).toBe('manual');
      await waitFor(async () => events.find((e) => e.type === 'nodeExecuteAfter'));
    } finally {
      unsubscribe();
    }
  });
});
