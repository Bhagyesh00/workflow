/**
 * P4-22: `POST /credentials/test` runs the test function that the node type's credential entry names
 * (`testedBy`). Run with TEST_DATABASE_URL=.../workflow_test_p4_credtest and TEST_REDIS_URL=redis://127.0.0.1:6379/10.
 */
import { HttpClient, NodeTypes } from '@workflow/core';
import type { CredentialTestContext, DataObject, NodeType } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSshServer } from '../../nodes-base/test/ssh-server';
import { testCredential } from '../src/services/credential-test';
import { createTestServer, resetDatabase, signup, type TestServer } from './helpers';

let server: TestServer;
let ssh: Awaited<ReturnType<typeof startSshServer>>;

beforeAll(async () => {
  server = await createTestServer();
  ssh = await startSshServer({ username: 'tester', password: 'ssh-pw' });
});
afterAll(async () => {
  await ssh.close();
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const OK = { status: 'OK', message: 'Connection tested successfully' };

describe('the route dispatches to the node that names the credential', () => {
  it('Postgres: passes on the right password, fails with a fixed text on a wrong one', async () => {
    const { client } = await signup(server.app);
    const base = { host: '127.0.0.1', port: 5432, database: 'nodes_test', user: 'postgres' };
    const ok = await client.data(
      client.post('/rest/credentials/test', { type: 'postgres', data: { ...base, password: 'postgres' } }),
    );
    expect(ok).toEqual(OK);
    const bad = await client.data(
      client.post('/rest/credentials/test', {
        type: 'postgres',
        data: { ...base, password: 'wrong-pw-secret' },
      }),
    );
    expect(bad).toEqual({ status: 'Error', message: 'Postgres refused the user name or password' });
  });

  it('SSH: passes on the right password, fails on a wrong one, runs no command', async () => {
    const { client } = await signup(server.app);
    const base = { host: '127.0.0.1', port: ssh.port, username: 'tester' };
    expect(
      await client.data(
        client.post('/rest/credentials/test', { type: 'sshPassword', data: { ...base, password: 'ssh-pw' } }),
      ),
    ).toEqual(OK);
    const bad = await client.data(
      client.post('/rest/credentials/test', { type: 'sshPassword', data: { ...base, password: 'nope' } }),
    );
    expect(bad).toEqual({ status: 'Error', message: 'SSH refused the user name, password or key' });
    expect(ssh.commands).toEqual([]);
  });

  it('a stored credential is tested with its secret when the editor sends the sentinel', async () => {
    const { client } = await signup(server.app);
    const base = { host: '127.0.0.1', port: ssh.port, username: 'tester' };
    const stored = await client.data(
      client.post('/rest/credentials', {
        name: 'ssh',
        type: 'sshPassword',
        data: { ...base, password: 'ssh-pw' },
      }),
    );
    const result = await client.data(
      client.post('/rest/credentials/test', {
        type: 'sshPassword',
        id: stored.id,
        data: { ...base, password: '__REDACTED__' },
      }),
    );
    expect(result).toEqual(OK);
  });

  it('a host the SSRF policy blocks is refused before any connection', async () => {
    const blocked = await createTestServer(
      {},
      { reset: false, http: new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } }) },
    );
    try {
      const { client } = await signup(blocked.app, { email: `blocked-${Date.now()}@example.test` });
      const before = ssh.connections;
      const result = await client.data(
        client.post('/rest/credentials/test', {
          type: 'sshPassword',
          data: { host: '127.0.0.1', port: ssh.port, username: 'tester', password: 'ssh-pw' },
        }),
      );
      expect(result.status).toBe('Error');
      expect(ssh.connections).toBe(before);
    } finally {
      await blocked.close();
    }
  });
});

describe('testCredential with a node that names a test', () => {
  const fakeNode = (
    credential: string,
    run: (ctx: CredentialTestContext, c: { type: string; data: DataObject }) => Promise<unknown>,
  ): NodeType =>
    ({
      description: {
        name: `fake.${credential}`,
        credentials: [{ name: credential, required: true, testedBy: 'fakeTest' }],
        properties: [],
      },
      methods: { credentialTest: { fakeTest: run } },
    }) as unknown as NodeType;

  const credentials = (parents: Record<string, string[]> = {}) =>
    ({
      resolvedType: () => ({ name: 'x', properties: [] }),
      withDefaults: (_t: string, d: DataObject) => ({ ...d, filled: true }),
      types: {
        isA: (name: string, parent: string) => name === parent || (parents[name] ?? []).includes(parent),
      },
    }) as never;

  const opts = (...nodes: NodeType[]) => ({
    nodeTypes: new NodeTypes(nodes),
    tenantId: 'tenant-1',
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  });
  const http = new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } });

  it('hands the test the type, the data with defaults, the tenant and a signal', async () => {
    let seen: { ctx: CredentialTestContext; type: string; data: DataObject; aborted: boolean } | undefined;
    const node = fakeNode('fakeCred', async (ctx, c) => {
      seen = { ctx, type: c.type, data: c.data, aborted: ctx.signal.aborted };
      return OK;
    });
    const result = await testCredential(credentials(), http, 'fakeCred', { a: 1 }, opts(node));
    expect(result).toEqual(OK);
    expect(seen?.type).toBe('fakeCred');
    expect(seen?.data).toEqual({ a: 1, filled: true });
    expect(seen?.ctx.getTenantId()).toBe('tenant-1');
    expect(seen?.aborted).toBe(false);
    // the signal ends with the test, so nothing it left open keeps running
    expect(seen?.ctx.signal.aborted).toBe(true);
    await expect(seen!.ctx.helpers.resolveAllowedHost('127.0.0.1')).resolves.toBeDefined();
  });

  it('runs the test of the parent type a credential extends', async () => {
    const node = fakeNode('baseCred', async (_ctx, c) => ({ status: 'OK', message: `ran for ${c.type}` }));
    const result = await testCredential(
      credentials({ childCred: ['baseCred'] }),
      http,
      'childCred',
      {},
      opts(node),
    );
    expect(result).toEqual({ status: 'OK', message: 'ran for childCred' });
  });

  it('never shows an error the test function throws', async () => {
    const node = fakeNode('fakeCred', async () => {
      throw new Error('password authentication failed for user "secret-user"');
    });
    const result = await testCredential(credentials(), http, 'fakeCred', {}, opts(node));
    expect(result).toEqual({ status: 'Error', message: "Couldn't test the credential" });
  });

  it('keeps the message of a failed result and fills an empty one', async () => {
    const failed = fakeNode('fakeCred', async () => ({ status: 'Error', message: 'Wrong password' }));
    expect(await testCredential(credentials(), http, 'fakeCred', {}, opts(failed))).toEqual({
      status: 'Error',
      message: 'Wrong password',
    });
    const bare = fakeNode('fakeCred', async () => ({ status: 'Error', message: '' }));
    expect((await testCredential(credentials(), http, 'fakeCred', {}, opts(bare))).message).not.toBe('');
  });

  it('a type no node tests keeps the old behaviour', async () => {
    const node = fakeNode('otherCred', async () => ({ status: 'Error', message: 'should not run' }));
    const result = await testCredential(credentials(), http, 'fakeCred', {}, opts(node));
    expect(result).toEqual({ status: 'OK', message: 'This credential type has no connection test' });
  });
});
