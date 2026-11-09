/**
 * P6-38 (L17): the test-run routes by project. Reads need `workflow:read`, runs, cancels and deletes
 * `workflow:execute`, both on the workflow in the path; a viewer of another project cannot read a run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const tenantId = owner.tenant.id;
  const alpha = await projectIn(server, tenantId, 'Alpha');
  const beta = await projectIn(server, tenantId, 'Beta');
  const inAlpha = await workflowIn(server, tenantId, alpha.id, { name: 'In alpha' });
  const run = await server.ctx.repos.testRuns.create(tenantId, {
    workflowId: inAlpha.id,
    status: 'completed',
  });
  const url = `/rest/workflows/${inAlpha.id}/test-runs`;
  return { owner, member, tenantId, alpha, beta, inAlpha, run, url };
}

describe('test runs by project', () => {
  it('refuses a member of no project and a viewer of another project on every route (403)', async () => {
    const { member, tenantId, beta, run, url } = await setup();
    const caseId = randomUUID();
    const all = () =>
      Promise.all([
        member.client.get(url),
        member.client.get(`${url}/${run.id}`),
        member.client.get(`${url}/${run.id}/test-cases`),
        member.client.post(`${url}/new`, {}),
        member.client.post(`${url}/${run.id}/cancel`),
        member.client.post(`${url}/${run.id}/test-cases/${caseId}/cancel`),
        member.client.delete(`${url}/${run.id}`),
      ]);
    for (const res of await all()) expect(res.statusCode).toBe(403);
    await addToProject(server, tenantId, beta.id, member.user.id, 'project:viewer');
    for (const res of await all()) expect(res.statusCode).toBe(403);
    expect(await server.ctx.repos.testRuns.get(tenantId, run.workflowId, run.id)).toBeTruthy();
  });

  it('lets a project viewer read but not run, cancel or delete', async () => {
    const { member, tenantId, alpha, run, url } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:viewer');
    expect((await member.client.get(url)).statusCode).toBe(200);
    expect((await member.client.get(`${url}/${run.id}`)).statusCode).toBe(200);
    expect((await member.client.get(`${url}/${run.id}/test-cases`)).statusCode).toBe(200);
    expect((await member.client.post(`${url}/new`, {})).statusCode).toBe(403);
    expect((await member.client.post(`${url}/${run.id}/cancel`)).statusCode).toBe(403);
    expect((await member.client.delete(`${url}/${run.id}`)).statusCode).toBe(403);
  });

  it('lets a project editor delete a run; the owner sees it gone', async () => {
    const { owner, member, tenantId, alpha, run, url } = await setup();
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:editor');
    expect((await member.client.delete(`${url}/${run.id}`)).statusCode).toBe(200);
    expect((await owner.client.get(`${url}/${run.id}`)).statusCode).toBe(404);
  });
});
