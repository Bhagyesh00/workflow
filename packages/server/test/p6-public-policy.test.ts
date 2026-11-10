/**
 * P6-34 (L13): GET and PUT /api/v1/settings/security-policy, `securitySettings:manage`. The answer holds the
 * settings (personal space publishing and sharing, default on) and the counts of what exists in personal
 * spaces; a change shows on the REST route of the same policy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

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

const api = (key: string, method: 'GET' | 'PUT', payload?: unknown) =>
  server.app.inject({
    method,
    url: '/api/v1/settings/security-policy',
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

let keyCount = 0;
/** a label is unique per user since P6-21, so each key gets its own */
async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  keyCount += 1;
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k${keyCount}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

describe('security policy', () => {
  it('returns the settings and the counts, on by default', async () => {
    const owner = await signup(server.app);
    const res = await api(await keyOf(owner.client), 'GET');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      personalSpacePublishing: true,
      personalSpaceSharing: true,
      publishedPersonalWorkflowsCount: 0,
      sharedPersonalWorkflowsCount: 0,
      sharedPersonalCredentialsCount: 0,
    });
  });

  it('changes only the fields sent, and the REST route shows the same policy', async () => {
    const owner = await signup(server.app);
    const key = await keyOf(owner.client);
    const off = await api(key, 'PUT', { personalSpacePublishing: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({ personalSpacePublishing: false, personalSpaceSharing: true });
    const rest = await owner.client.data(owner.client.get('/rest/settings/security'));
    expect(rest).toMatchObject({ personalSpacePublishing: false, personalSpaceSharing: true });
    const both = await api(key, 'PUT', { personalSpacePublishing: true, personalSpaceSharing: false });
    expect(both.json().data).toMatchObject({ personalSpacePublishing: true, personalSpaceSharing: false });
    expect((await api(key, 'GET')).json().data.personalSpaceSharing).toBe(false);
    expect((await api(key, 'PUT', { personalSpaceSharing: 'no' })).statusCode).toBe(400);
  });

  it('a member, and a key without the scope, are refused with n8n’s text', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const memberKey = await keyOf(member.client);
    for (const method of ['GET', 'PUT'] as const) {
      const res = await api(
        memberKey,
        method,
        method === 'PUT' ? { personalSpaceSharing: false } : undefined,
      );
      expect(res.statusCode, method).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
    const narrow = await keyOf(owner.client, ['tag:list']);
    expect((await api(narrow, 'GET')).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/v1/settings/security-policy' })).statusCode).toBe(401);
    // nothing changed by the refused calls
    const state = await api(await keyOf(owner.client), 'GET');
    expect(state.json().data.personalSpaceSharing).toBe(true);
  });
});
