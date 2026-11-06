/**
 * External secrets (P4-07): the vault value never reaches execution data, push, audit, logs or API
 * output (GHSA-89gh), and `$secrets` does not exist in node parameters or Code (GHSA-2434).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { createLogger } from '../src/logger';
import type { SecretProvider, SecretProviderType } from '../src/services/secrets/types';
import {
  chain,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  signup,
  testConfig,
  testPackage,
  waitForExecution,
} from './helpers';

const VALUE = `vault-value-${randomUUID()}`;
const TOKEN = `vault-token-${randomUUID()}`;

let secretsStore: Record<string, unknown> = {};
let failing = false;

const leakType: SecretProviderType = {
  name: 'leakVault',
  displayName: 'Leak test vault',
  properties: [
    { displayName: 'Token', name: 'token', type: 'string', default: '', typeOptions: { password: true } },
  ],
  create: (): SecretProvider => {
    let held: Record<string, unknown> = {};
    return {
      init: async () => {},
      connect: async () => {
        if (failing) throw new Error(`the vault said ${VALUE} and ${TOKEN}`);
      },
      update: async () => {
        if (failing) throw new Error(`the vault said ${VALUE} and ${TOKEN}`);
        held = { ...secretsStore };
      },
      test: async () => ({
        success: !failing,
        error: failing ? 'The vault answered with an error' : undefined,
      }),
      getSecret: (name) => held[name],
      hasSecret: (name) => Object.hasOwn(held, name),
      getSecretNames: () => Object.keys(held),
      disconnect: async () => {},
    };
  },
};

const logLines: string[] = [];
const pushed: string[] = [];
let ctx: ServerContext;
let app: Awaited<ReturnType<typeof buildApp>>;
let remote: Server;
let remoteUrl: string;
let remoteStatus = 200;
let remoteReply: (url: string, auth: unknown) => string = () => '{"ok":true}';

beforeAll(async () => {
  remote = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(remoteStatus, { 'content-type': 'application/json' });
      res.end(remoteReply(req.url ?? '', req.headers['x-from-vault']));
    });
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
  ctx = await createContext({
    config: testConfig({ LOG_LEVEL: 'debug' }),
    logger: createLogger(
      'debug',
      { service: 'workflow-server' },
      { write: (line: string) => logLines.push(line) },
    ),
    nodePackages: [nodesBasePackage, testPackage],
    secretProviderTypes: [leakType],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  app = await buildApp(ctx);
  await app.ready();
  await ctx.startMain();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
  await new Promise((r) => remote.close(r));
});
beforeEach(() => {
  secretsStore = { key: VALUE };
  failing = false;
  remoteStatus = 200;
  remoteReply = () => '{"ok":true}';
  logLines.length = 0;
  pushed.length = 0;
});

async function workspace() {
  const owner = await signup(app);
  await ctx.push.subscribe(owner.tenant.id, (event) => pushed.push(JSON.stringify(event)));
  await owner.client.data(
    owner.client.post('/rest/secret-providers/connections', {
      providerKey: 'main',
      type: 'leakVault',
      settings: { token: TOKEN },
      isEnabled: true,
    }),
  );
  return owner;
}

async function everything(owner: Awaited<ReturnType<typeof workspace>>, executionId?: string) {
  const parts: unknown[] = [
    await owner.client.data(owner.client.get('/rest/secret-providers/connections')),
    await owner.client.data(owner.client.get('/rest/secret-providers/completions/secrets')),
    await owner.client.data(owner.client.get('/rest/audit-log')),
    await owner.client.data(owner.client.get('/rest/credentials')),
  ];
  if (executionId) {
    parts.push(await owner.client.data(owner.client.get(`/rest/executions/${executionId}`)));
    parts.push(await ctx.repos.executions.get(owner.tenant.id, executionId));
  }
  return JSON.stringify(parts);
}

const expectNoLeak = (text: string) => {
  expect(text).not.toContain(VALUE);
  expect(text).not.toContain(TOKEN);
};

describe('the vault value stays out of everything but the outgoing request', () => {
  it('a successful run: execution data, push, audit, logs, API', async () => {
    const owner = await workspace();
    let seen: unknown;
    remoteReply = (_url, auth) => {
      seen = auth;
      return '{"ok":true}';
    };
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Header',
        type: 'httpHeaderAuth',
        data: { name: 'x-from-vault', value: '={{ $secrets.main.key }}' },
      }),
    );
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          {
            url: `${remoteUrl}/echo`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpHeaderAuth',
            options: { response: { response: { fullResponse: true } } },
          },
          [200, 0],
          { credentials: { httpHeaderAuth: { id: credential.id, name: 'Header' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['success']);
    expect(seen).toBe(VALUE);

    expectNoLeak(await everything(owner, executionId));
    expectNoLeak(pushed.join('\n'));
    expectNoLeak(logLines.join('\n'));
    expect(pushed.length).toBeGreaterThan(0);
    const raw = await owner.client.data(owner.client.get(`/rest/credentials/${credential.id}`));
    expectNoLeak(JSON.stringify(raw));
    expect(raw.data.value).toBe('={{ $secrets.main.key }}');
  });

  it('a failed request: the error and its request summary', async () => {
    const owner = await workspace();
    remoteStatus = 500;
    remoteReply = () => '{"error":"nope"}';
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Header',
        type: 'httpHeaderAuth',
        data: { name: 'x-from-vault', value: '={{ $secrets.main.key }}' },
      }),
    );
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          {
            url: `${remoteUrl}/fails`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpHeaderAuth',
          },
          [200, 0],
          { credentials: { httpHeaderAuth: { id: credential.id, name: 'Header' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['error']);
    expectNoLeak(await everything(owner, executionId));
    expectNoLeak(pushed.join('\n'));
    expectNoLeak(logLines.join('\n'));
  });

  it.each([
    ['a line break', (secret: string) => `${secret}\nsecond-line`],
    ['a character outside latin-1', (secret: string) => `${secret}\u20ac`],
  ])('a header value the request cannot send: %s', async (_label, shape) => {
    secretsStore = { key: shape(VALUE) };
    const owner = await workspace();
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Header',
        type: 'httpHeaderAuth',
        data: { name: 'x-from-vault', value: '={{ $secrets.main.key }}' },
      }),
    );
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          {
            url: `${remoteUrl}/never`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpHeaderAuth',
          },
          [200, 0],
          { credentials: { httpHeaderAuth: { id: credential.id, name: 'Header' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['error']);
    const all = await everything(owner, executionId);
    expect(all).toContain('A request header has a name or value that cannot be sent');
    expectNoLeak(all);
    expect(all).not.toContain('second-line');
    expect(all).not.toContain('8364');
    expectNoLeak(pushed.join('\n'));
    expectNoLeak(logLines.join('\n'));
  });

  it('a failed request with the value in its query string', async () => {
    const owner = await workspace();
    remoteStatus = 500;
    let requested = '';
    remoteReply = (url) => {
      requested = url;
      return '{"error":"nope"}';
    };
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Query',
        type: 'httpQueryAuth',
        data: { name: 'api_key', value: '={{ $secrets.main.key }}' },
      }),
    );
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          {
            url: `${remoteUrl}/fails`,
            authentication: 'genericCredentialType',
            genericAuthType: 'httpQueryAuth',
          },
          [200, 0],
          { credentials: { httpQueryAuth: { id: credential.id, name: 'Query' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['error']);
    expect(requested).toContain(VALUE);
    expectNoLeak(await everything(owner, executionId));
    expectNoLeak(pushed.join('\n'));
    expectNoLeak(logLines.join('\n'));
  });

  it('a provider that throws its response: lastError, test answer, logs and audit stay fixed', async () => {
    const owner = await workspace();
    failing = true;
    const reload = await owner.client.data(
      owner.client.post('/rest/secret-providers/connections/main/reload'),
    );
    expect(reload.success).toBe(false);
    const test = await owner.client.data(owner.client.post('/rest/secret-providers/connections/main/test'));
    expect(test.success).toBe(false);
    const dto = await owner.client.data(owner.client.get('/rest/secret-providers/connections/main'));
    expect(dto.lastError).toBeTruthy();

    const created = await owner.client.data(
      owner.client.post('/rest/secret-providers/connections', {
        providerKey: 'second',
        type: 'leakVault',
        settings: { token: TOKEN },
        isEnabled: true,
      }),
    );
    expectNoLeak(JSON.stringify([reload, test, dto, created]));
    expectNoLeak(await everything(owner));
    expectNoLeak(logLines.join('\n'));
    const row = await ctx.repos.secrets.get(owner.tenant.id, 'second');
    expectNoLeak(JSON.stringify({ ...row, settingsEnc: '' }));
    expect(row?.settingsEnc).not.toContain(TOKEN);
  });

  it('the credential test answer never echoes a resolved value', async () => {
    const owner = await workspace();
    const answer = await owner.client.data(
      owner.client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: '={{ $secrets.main.key }}', apiKey: 'x' },
      }),
    );
    expect(answer.status).toBe('Error');
    expectNoLeak(JSON.stringify(answer));
    expectNoLeak(logLines.join('\n'));
  });

  it('a secret named by a saved credential comes back as the expression, never as plaintext (GHSA-fxcw)', async () => {
    const owner = await workspace();
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Saved',
        type: 'testApi',
        data: { baseUrl: '={{ $secrets.main.key }}', apiKey: '={{ $secrets.main.key }}' },
      }),
    );
    expectNoLeak(JSON.stringify(credential));
    const read = await owner.client.data(owner.client.get(`/rest/credentials/${credential.id}`));
    expectNoLeak(JSON.stringify(read));
    const patched = await owner.client.data(
      owner.client.patch(`/rest/credentials/${credential.id}`, { name: 'Renamed' }),
    );
    expectNoLeak(JSON.stringify(patched));
  });
});

describe('$secrets exists only while credential data is read (GHSA-2434)', () => {
  it('is undefined in node parameters', async () => {
    const owner = await workspace();
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Set',
          'core.set',
          {
            mode: 'manual',
            assignments: {
              assignments: [{ name: 'kind', type: 'string', value: '={{ typeof $secrets }}' }],
            },
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Set'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['success']);
    const execution = await owner.client.data(owner.client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Set')).toEqual([{ kind: 'undefined' }]);
  });

  it('a read of it in a node parameter fails without the value', async () => {
    const owner = await workspace();
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Set',
          'core.set',
          {
            mode: 'manual',
            assignments: {
              assignments: [{ name: 'leak', type: 'string', value: '={{ $secrets.main.key }}' }],
            },
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Set'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['error']);
    expectNoLeak(await everything(owner, executionId));
  });

  it('is undefined in the Code node', async () => {
    const owner = await workspace();
    const wf = await createWorkflow(owner.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Code',
          'core.code',
          {
            mode: 'runOnceForAllItems',
            language: 'javaScript',
            jsCode: 'return [{ json: { kind: typeof $secrets } }];',
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Code'),
    });
    const { executionId } = await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(ctx, owner.tenant.id, executionId, ['success']);
    const execution = await owner.client.data(owner.client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Code')).toEqual([{ kind: 'undefined' }]);
  });

  it('the data proxy has no $secrets', () => {
    const source = readFileSync(path.join(__dirname, '../../workflow/src/expression/data-proxy.ts'), 'utf8');
    expect(source).not.toContain('$secrets');
  });
});
