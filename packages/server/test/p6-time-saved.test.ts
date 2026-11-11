/**
 * P6-56 (L12) time saved, end to end: production webhook runs of workflows with Track Time Saved nodes (or
 * the fixed number) go through the real collector (`ctx.insights.flush()` by hand) and the real summary route.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
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
  await server.ctx.insights.flush().catch(() => {});
  await resetDatabase(server.ctx);
});

type Owner = Awaited<ReturnType<typeof signup>>;
type Node = ReturnType<typeof node>;

const FINISHED = ['success', 'error', 'canceled', 'crashed'];

/** three items out of the webhook, then `tail` in a line */
const three = (): Node =>
  node('Three', 'core.code', {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]',
  });

/** one production run of a webhook workflow; answers the run's status */
async function runOnce(owner: Owner, nodes: Node[], settings: Record<string, unknown>) {
  const path = `p-${randomUUID().slice(0, 8)}`;
  const hook = node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], {
    webhookId: randomUUID(),
  });
  const workflow = await createWorkflow(owner.client, {
    name: `Saved ${randomUUID().slice(0, 6)}`,
    nodes: [hook, ...nodes],
    connections: chain('Hook', ...nodes.map((n) => n.name)),
    settings: settings as never,
  });
  await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/activate`));
  const res = await server.app.inject({
    method: 'POST',
    url: `/webhook/${owner.tenant.slug}/${path}`,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const row = await waitFor(
    async () =>
      (await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: workflow.id, limit: 1 }))[0],
    { message: 'the run to start' },
  );
  const done = await waitForExecution(server.ctx, owner.tenant.id, row.id, FINISHED);
  await server.ctx.insights.flush();
  return done;
}

const timeSaved = async (owner: Owner) =>
  (await owner.client.data<Record<string, { value: number }>>(owner.client.get('/rest/insights/summary')))
    .timeSaved.value;

describe('time saved through the collector and the summary', () => {
  it('fixed: 5 minutes on a workflow that ran 3 items counts 5 once (n8n does not multiply)', async () => {
    const owner = await signup(server.app);
    await runOnce(owner, [three()], { timeSavedMode: 'fixed', timeSavedPerExecution: 5 });
    expect(await timeSaved(owner)).toBe(5);
  });

  it('fixed: 5 minutes on 3 successful runs gives 15', async () => {
    const owner = await signup(server.app);
    for (let i = 0; i < 3; i++)
      await runOnce(owner, [three()], { timeSavedMode: 'fixed', timeSavedPerExecution: 5 });
    expect(await timeSaved(owner)).toBe(15);
  });

  it('dynamic, once: two nodes of 4 and 6 minutes on 3 items give 10', async () => {
    const owner = await signup(server.app);
    await runOnce(
      owner,
      [
        three(),
        node('Saved A', 'core.timeSaved', { mode: 'once', minutesSaved: 4 }),
        node('Saved B', 'core.timeSaved', { mode: 'once', minutesSaved: 6 }),
      ],
      { timeSavedMode: 'dynamic', timeSavedPerExecution: 99 },
    );
    expect(await timeSaved(owner)).toBe(10);
  });

  it('dynamic, per item: two nodes of 2 and 3 minutes on 3 items give 15', async () => {
    const owner = await signup(server.app);
    await runOnce(
      owner,
      [
        three(),
        node('Saved A', 'core.timeSaved', { mode: 'perItem', minutesSaved: 2 }),
        node('Saved B', 'core.timeSaved', { mode: 'perItem', minutesSaved: 3 }),
      ],
      { timeSavedMode: 'dynamic' },
    );
    expect(await timeSaved(owner)).toBe(15);
  });

  it('dynamic: once plus per item add up (4 once, 2 per item on 3 items gives 10)', async () => {
    const owner = await signup(server.app);
    await runOnce(
      owner,
      [
        three(),
        node('Saved A', 'core.timeSaved', { mode: 'once', minutesSaved: 4 }),
        node('Saved B', 'core.timeSaved', { mode: 'perItem', minutesSaved: 2 }),
      ],
      { timeSavedMode: 'dynamic' },
    );
    expect(await timeSaved(owner)).toBe(10);
  });

  it('fixed mode ignores the nodes, and a failed run saves nothing', async () => {
    const owner = await signup(server.app);
    await runOnce(owner, [node('Saved', 'core.timeSaved', { mode: 'once', minutesSaved: 40 })], {
      timeSavedMode: 'fixed',
      timeSavedPerExecution: 2,
    });
    expect(await timeSaved(owner)).toBe(2);
    const failed = await runOnce(
      owner,
      [node('Saved', 'core.timeSaved', { mode: 'once', minutesSaved: -1 })],
      { timeSavedMode: 'dynamic' },
    );
    expect(failed.status).toBe('error');
    expect(await timeSaved(owner)).toBe(2);
  });
});
