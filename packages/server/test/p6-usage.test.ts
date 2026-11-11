/** P6-84 (L16): GET /settings usage.activeWorkflows: the tenant's active count, the limit from limits. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

let server: TestServer;
let ip = 1;
beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
const world = () => signup(server.app, { remoteAddress: `127.8.0.${(ip++ % 250) + 1}` });
const settings = async (w: Awaited<ReturnType<typeof world>>) =>
  (await w.client.get('/rest/settings')).json().data as {
    usage?: { activeWorkflows?: number };
    limits: { activeWorkflows: number | null };
  };

describe('usage.activeWorkflows', () => {
  it('counts active workflows of the tenant only and sends the limit', async () => {
    const a = await world();
    const b = await world();
    const repos = server.ctx.repos;
    for (const [w, n] of [
      [a, 2],
      [b, 3],
    ] as const) {
      const pid = await teamProjectOf(server, w.tenant.id);
      for (let i = 0; i < n; i++) {
        const wf = await workflowIn(server, w.tenant.id, pid);
        await repos.workflows.setActive(w.tenant.id, wf.id, true);
      }
      await workflowIn(server, w.tenant.id, pid); // inactive
    }
    await repos.tenants.updateSettings(a.tenant.id, { limits: { activeWorkflows: 5 } });
    const sa = await settings(a);
    expect(sa.usage?.activeWorkflows).toBe(2);
    expect(sa.limits.activeWorkflows).toBe(5);
    expect((await settings(b)).usage?.activeWorkflows).toBe(3);
  });

  it('sends the active count when the month has no usage row yet', async () => {
    const a = await world();
    const pid = await teamProjectOf(server, a.tenant.id);
    const wf = await workflowIn(server, a.tenant.id, pid);
    await server.ctx.repos.workflows.setActive(a.tenant.id, wf.id, true);
    const sa = await settings(a);
    expect(sa.usage?.activeWorkflows).toBe(1);
  });

  it('sends no usage signed out', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/rest/settings' });
    expect(res.json().data.usage).toBeUndefined();
  });
});
