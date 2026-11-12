/**
 * P6 S4 (C0c): the server contracts of commit 0. `API_KEY_SCOPES` gains `sourceControl:push` and
 * `sourceControl:read` right after `sourceControl:pull`; every new public row (source control, discover, the CLI's
 * rows) has `access` and a key `scope`, or `anyKey`, and its answer is named in the OpenAPI components; an `anyKey`
 * row takes any valid key; every new REST route answers at its final path with its gate (a stub's answer is not
 * checked, only that the path exists and the gate holds); `config.sourceControl.defaultKeyType`; the context builds
 * and closes with the new services and repositories; each command module exports its function; `processIo` writes
 * with the mode on the call; `rewriteUuids` (FULL); `pushableProjects` passes fail closed.
 */
import { randomUUID } from 'node:crypto';
import { chmod, readFile as fsReadFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodesBasePackage } from '@workflow/nodes-base';
import { SCOPES } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as auditModule from '../src/commands/audit';
import { processIo } from '../src/commands/command-io';
import * as credentialsExportModule from '../src/commands/credentials-export';
import * as credentialsImportModule from '../src/commands/credentials-import';
import * as executeModule from '../src/commands/execute';
import * as executeBatchModule from '../src/commands/execute-batch';
import * as nodesExportModule from '../src/commands/nodes-export';
import * as workflowExportModule from '../src/commands/workflow-export';
import * as workflowImportModule from '../src/commands/workflow-import';
import * as workflowListModule from '../src/commands/workflow-list';
import * as workflowPublishModule from '../src/commands/workflow-publish';
import { ConfigError } from '../src/config';
import { createContext } from '../src/context';
import { API_KEY_SCOPES } from '../src/http/api-key-scopes';
import { SourceControlRepository } from '../src/repositories/source-control';
import { SyncIdMapRepository } from '../src/repositories/sync-id-map';
import type { ApiRoute } from '../src/routes/public-api';
import { PUBLIC_CLI_ROUTES } from '../src/routes/public-cli-routes';
import { PUBLIC_DISCOVER_ROUTES } from '../src/routes/public-discover';
import { PUBLIC_SOURCE_CONTROL_ROUTES } from '../src/routes/public-source-control';
import { rewriteUuids } from '../src/services/rewrite-uuids';
import { pushableProjects } from '../src/services/source-control/scope';
import { SourceControlSettingsService } from '../src/services/source-control/settings';
import { SourceControlSyncService } from '../src/services/source-control/sync';
import {
  createTestServer,
  ORIGIN,
  realMember,
  signup,
  TestClient,
  type TestServer,
  teamProjectOf,
  testConfig,
  testPackage,
  workflowIn,
} from './helpers';

// the mode of a write is asserted on the call (Windows ignores it on `stat`): wrap the real functions
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod), writeFile: vi.fn(actual.writeFile) };
});

let server: TestServer;
let binaryDir: string;

beforeAll(async () => {
  server = await createTestServer();
  binaryDir = await mkdtemp(path.join(tmpdir(), 'wf-p6s4-config-'));
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (binaryDir) await rm(binaryDir, { recursive: true, force: true });
});

const S4_PUBLIC_ROWS: Record<string, ApiRoute[]> = {
  PUBLIC_SOURCE_CONTROL_ROUTES,
  PUBLIC_DISCOVER_ROUTES,
  PUBLIC_CLI_ROUTES,
};

const ROUTER_404 = /^Route .* not found$/;

async function keyFor(client: TestClient, scopes?: string[]) {
  const body: Record<string, unknown> = { name: `p6s4-${randomUUID().slice(0, 8)}` };
  if (scopes) body.scopes = scopes;
  const key = await client.data<{ key: string }>(client.post('/rest/api-keys', body));
  return key.key;
}

describe('P6 S4 API key scopes', () => {
  it('sourceControl:push and sourceControl:read sit right after sourceControl:pull, each once', () => {
    const at = API_KEY_SCOPES.indexOf('sourceControl:pull');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(API_KEY_SCOPES.slice(at, at + 3)).toEqual([
      'sourceControl:pull',
      'sourceControl:push',
      'sourceControl:read',
    ]);
    // P6 S5 appends seven (90); later stages add more, so the count is a floor
    expect(API_KEY_SCOPES.length).toBeGreaterThanOrEqual(83);
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
    for (const scope of ['sourceControl:push', 'sourceControl:read']) {
      expect(SCOPES as readonly string[]).toContain(scope);
    }
  });
});

describe('P6 S4 public rows', () => {
  it('every new public row has `access` and a key scope, or `anyKey` with open access', () => {
    for (const [name, rows] of Object.entries(S4_PUBLIC_ROWS)) {
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) {
        const label = `${name} ${row.method} ${row.path}`;
        expect(row.access, label).toBeDefined();
        expect(typeof row.handler, label).toBe('function');
        if (row.anyKey) {
          expect(row.access, label).toEqual({ open: true });
          continue;
        }
        expect('scope' in row.access, label).toBe(true);
        const userScopes = 'scope' in row.access ? [row.access.scope].flat() : [];
        for (const scope of userScopes) expect(SCOPES as readonly string[], label).toContain(scope);
        expect(API_KEY_SCOPES as readonly string[], label).toContain(row.scope);
      }
    }
  });

  it('the rows sit at their final paths with their scopes and access', () => {
    const summary = (rows: ApiRoute[]) =>
      Object.fromEntries(
        rows.map((r) => [
          `${r.method} ${r.path}`,
          {
            scope: r.scope ?? null,
            access: 'scope' in r.access ? r.access.scope : 'open',
            list: 'list' in r.access ? r.access.list === true : false,
            target: 'target' in r.access && typeof r.access.target === 'function',
            anyKey: r.anyKey === true,
          },
        ]),
      );
    const row = (scope: string | null, access: string, extra: Partial<Record<string, boolean>> = {}) => ({
      scope,
      access,
      list: false,
      target: false,
      anyKey: false,
      ...extra,
    });
    expect(summary(PUBLIC_SOURCE_CONTROL_ROUTES)).toEqual({
      'GET /source-control/status': row('sourceControl:read', 'sourceControl:read'),
      'POST /source-control/push': row('sourceControl:push', 'sourceControl:push', { list: true }),
      'POST /source-control/pull': row('sourceControl:pull', 'sourceControl:pull'),
    });
    expect(summary(PUBLIC_DISCOVER_ROUTES)).toEqual({
      'GET /discover': row(null, 'open', { anyKey: true }),
    });
    expect(summary(PUBLIC_CLI_ROUTES)).toEqual({
      'GET /workflows/:id/tags': row('workflowTags:list', 'workflow:read', { target: true }),
      'PUT /workflows/:id/tags': row('workflowTags:update', 'workflow:update', { target: true }),
      'POST /executions/:id/stop': row('execution:stop', 'workflow:execute', { target: true }),
      'GET /credentials': row('credential:list', 'credential:list', { list: true }),
      'GET /credentials/:id': row('credential:read', 'credential:read', { target: true }),
    });
    // the targets name the row the path points at
    const target = (method: string, p: string) => {
      const found = PUBLIC_CLI_ROUTES.find((r) => r.method === method && r.path === p);
      return found && 'target' in found.access ? found.access.target : undefined;
    };
    const req = { params: { id: 'x1' }, query: {}, body: {} };
    expect(target('GET', '/workflows/:id/tags')?.(req)).toEqual({ workflowId: 'x1' });
    expect(target('POST', '/executions/:id/stop')?.(req)).toEqual({ executionId: 'x1' });
    expect(target('GET', '/credentials/:id')?.(req)).toEqual({ credentialId: 'x1' });
  });

  it('the OpenAPI document names every S4 answer and the two new tags', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    const schemas = doc.components.schemas as Record<string, unknown>;
    const names = new Set(Object.values(S4_PUBLIC_ROWS).flatMap((rows) => rows.map((r) => r.response)));
    for (const name of names) expect(schemas[name], name).toBeDefined();
    for (const name of [
      'SourceControlledFile',
      'PushResult',
      'PullResult',
      'DiscoverResponse',
      'WorkflowTag',
    ]) {
      expect(schemas[name], name).toBeDefined();
    }
    const tags = (doc.tags as Array<{ name: string }>).map((t) => t.name);
    expect(tags).toEqual(expect.arrayContaining(['SourceControl', 'Discover']));
    expect(doc.paths['/discover']?.get).toBeDefined();
    expect(doc.paths['/workflows/{id}/tags']?.put).toBeDefined();
  });

  it('every new public row answers at its path; an anyKey row takes a narrow key, a scoped row refuses it', async () => {
    const owner = await signup(server.app);
    const projectId = await teamProjectOf(server, owner.tenant.id);
    const workflow = await workflowIn(server, owner.tenant.id, projectId);
    const full = await keyFor(owner.client);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, key: string, payload?: unknown) =>
      server.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { 'x-api-key': key },
        payload: payload as never,
      });
    const id = randomUUID();
    const calls: Array<['GET' | 'POST' | 'PUT', string, unknown?]> = [
      ['GET', '/source-control/status'],
      ['POST', '/source-control/push', { fileNames: [{ id, type: 'workflow' }] }],
      ['POST', '/source-control/pull', {}],
      ['GET', '/discover'],
      ['GET', `/workflows/${workflow.id}/tags`],
      ['PUT', `/workflows/${workflow.id}/tags`, []],
      ['POST', `/executions/${id}/stop`],
      ['GET', '/credentials'],
      ['GET', `/credentials/${id}`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await call(method, url, full, payload);
      const message = res.statusCode === 404 ? (res.json().error?.message ?? res.json().message ?? '') : '';
      expect(message, `${method} ${url}`).not.toMatch(ROUTER_404);
      expect(res.statusCode, `${method} ${url}`).not.toBe(403);
    }
    // a key holding only tag:list: refused by a scoped row before any work, let through by the anyKey row
    const narrow = await keyFor(owner.client, ['tag:list']);
    expect((await call('GET', '/source-control/status', narrow)).statusCode).toBe(403);
    expect((await call('POST', '/source-control/pull', narrow, {})).statusCode).toBe(403);
    expect((await call('GET', `/workflows/${workflow.id}/tags`, narrow)).statusCode).toBe(403);
    expect((await call('GET', '/discover', narrow)).statusCode).not.toBe(403);
    // the anyKey row still needs a valid key
    const anonymous = await server.app.inject({ method: 'GET', url: '/api/v1/discover' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('P6 S4 REST routes', () => {
  const REST: Array<['GET' | 'POST' | 'PATCH', string]> = [
    ['GET', '/source-control/preferences'],
    ['POST', '/source-control/preferences'],
    ['PATCH', '/source-control/preferences'],
    ['POST', '/source-control/disconnect'],
    ['GET', '/source-control/get-branches'],
    ['POST', '/source-control/generate-key-pair'],
    ['GET', '/source-control/get-status'],
    ['GET', '/source-control/status'],
    ['POST', '/source-control/push-workfolder'],
    ['POST', '/source-control/pull-workfolder'],
    ['GET', `/source-control/remote-content/workflow/${randomUUID()}`],
  ];

  it('every new REST route answers at its final path (never the router 404)', async () => {
    const owner = await signup(server.app);
    expect(REST).toHaveLength(11);
    for (const [method, p] of REST) {
      const res = await owner.client.request(method, `/rest${p}`, method === 'GET' ? undefined : {});
      const body = res.statusCode === 404 ? res.json() : undefined;
      expect(body?.error?.message ?? '', `${method} ${p}`).not.toMatch(ROUTER_404);
      expect(res.statusCode, `${method} ${p}`).not.toBe(403);
    }
  });

  it('a signed-out caller gets 401 on every new REST route', async () => {
    const anonymous = new TestClient(server.app, ORIGIN);
    for (const [method, p] of REST) {
      const res = await anonymous.request(method, `/rest${p}`, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${p}`).toBe(401);
    }
  });

  it('a true member: 403 on the manage and pull routes, through the gate on the list filter routes', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const denied: Array<['GET' | 'POST' | 'PATCH', string]> = [
      ['POST', '/source-control/preferences'],
      ['PATCH', '/source-control/preferences'],
      ['POST', '/source-control/disconnect'],
      ['GET', '/source-control/get-branches'],
      ['POST', '/source-control/generate-key-pair'],
      ['POST', '/source-control/pull-workfolder'],
      ['GET', '/source-control/status?direction=pull'],
      ['GET', '/source-control/get-status?direction=pull'],
    ];
    for (const [method, p] of denied) {
      const res = await member.client.request(method, `/rest${p}`, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${p}`).toBe(403);
      expect(res.json().error.message).toBe('User is missing a scope required to perform this action');
    }
    const passed: Array<['GET' | 'POST', string]> = [
      ['GET', '/source-control/preferences'],
      ['GET', '/source-control/status'],
      ['GET', '/source-control/get-status?direction=push'],
      ['POST', '/source-control/push-workfolder'],
      ['GET', `/source-control/remote-content/workflow/${randomUUID()}`],
    ];
    for (const [method, p] of passed) {
      const res = await member.client.request(method, `/rest${p}`, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${p}`).not.toBe(403);
      expect(res.statusCode, `${method} ${p}`).not.toBe(401);
    }
  });
});

describe('P6 S4 config', () => {
  const config = (value?: string) =>
    testConfig({
      BINARY_DATA_DIR: binaryDir,
      ...(value === undefined ? {} : { SOURCECONTROL_DEFAULT_SSH_KEY_TYPE: value }),
    });

  it('sourceControl.defaultKeyType is ed25519 by default and takes rsa', () => {
    expect(config().sourceControl).toEqual({ defaultKeyType: 'ed25519' });
    expect(config('rsa').sourceControl.defaultKeyType).toBe('rsa');
    expect(config('ed25519').sourceControl.defaultKeyType).toBe('ed25519');
  });

  it('any other key type is a ConfigError', () => {
    for (const bad of ['dsa', 'RSA', 'ecdsa', 'ed25519 ']) {
      expect(() => config(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('P6 S4 context', () => {
  it('the server context holds the source control services and repositories', () => {
    expect(server.ctx.sourceControl).toBeInstanceOf(SourceControlSettingsService);
    expect(server.ctx.sourceControlSync).toBeInstanceOf(SourceControlSyncService);
    expect(server.ctx.sourceControl.deps).toBe(server.ctx.serviceDeps);
    expect(server.ctx.sourceControlSync.deps).toBe(server.ctx.serviceDeps);
    expect(server.ctx.repos.sourceControl).toBeInstanceOf(SourceControlRepository);
    expect(server.ctx.repos.syncIdMap).toBeInstanceOf(SyncIdMapRepository);
  });

  it('a context builds and closes', async () => {
    const ctx = await createContext({
      config: testConfig({ BINARY_DATA_DIR: binaryDir }),
      nodePackages: [nodesBasePackage, testPackage],
    });
    try {
      expect(ctx.sourceControl).toBeInstanceOf(SourceControlSettingsService);
      expect(ctx.sourceControlSync).toBeInstanceOf(SourceControlSyncService);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});

describe('P6 S4 pushableProjects (PASSES, fail closed until L5)', () => {
  it("is 'all' for the owner and an empty set for a true member", async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const authOf = async (userId: string) => {
      const tenant = await server.ctx.repos.tenants.get(owner.tenant.id);
      const user = await server.ctx.repos.users.get(userId);
      const membership = await server.ctx.repos.memberships.get(owner.tenant.id, userId);
      return { user: user!, tenant: tenant!, role: membership!.role };
    };
    expect(await pushableProjects(server.ctx.serviceDeps, await authOf(owner.user.id))).toBe('all');
    const memberScope = await pushableProjects(server.ctx.serviceDeps, await authOf(member.user.id));
    expect(memberScope).toBeInstanceOf(Set);
    expect((memberScope as Set<string>).size).toBe(0);
  });
});

describe('P6 S4 commands', () => {
  it('each command module exports its function', () => {
    const exported: Array<[string, unknown]> = [
      ['exportWorkflowCommand', workflowExportModule.exportWorkflowCommand],
      ['importWorkflowCommand', workflowImportModule.importWorkflowCommand],
      ['listWorkflowCommand', workflowListModule.listWorkflowCommand],
      ['publishWorkflowCommand', workflowPublishModule.publishWorkflowCommand],
      ['unpublishWorkflowCommand', workflowPublishModule.unpublishWorkflowCommand],
      ['exportCredentialsCommand', credentialsExportModule.exportCredentialsCommand],
      ['importCredentialsCommand', credentialsImportModule.importCredentialsCommand],
      ['exportNodesCommand', nodesExportModule.exportNodesCommand],
      ['executeCommand', executeModule.executeCommand],
      ['executeBatchCommand', executeBatchModule.executeBatchCommand],
      ['auditCommand', auditModule.auditCommand],
    ];
    expect(exported).toHaveLength(11);
    for (const [name, fn] of exported) expect(typeof fn, name).toBe('function');
  });

  it('cli.ts dispatches the eleven commands', async () => {
    const source = await fsReadFile(path.join(__dirname, '../src/cli.ts'), 'utf8');
    for (const command of [
      'export:workflow',
      'import:workflow',
      'list:workflow',
      'publish:workflow',
      'unpublish:workflow',
      'export:credentials',
      'import:credentials',
      'export:nodes',
      'execute',
      'execute-batch',
      'audit',
    ]) {
      // Biome (quoteProperties asNeeded) writes a plain identifier key unquoted: `execute: executeCommand`
      const escaped = command.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      expect(source, command).toMatch(new RegExp(`'${escaped}'\\s*:|^\\s*${escaped}\\s*:`, 'm'));
    }
    expect(source).toContain('process.exitCode = await');
  });
});

describe('P6 S4 processIo', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    vi.mocked(writeFile).mockClear();
    vi.mocked(chmod).mockClear();
  });

  it('writes and reads UTF-8 files; a mode goes on the write call and on chmod', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wf-p6s4-io-'));
    const io = processIo();
    const plain = path.join(dir, 'plain.json');
    await io.writeFile(plain, '{"a":"é"}', {});
    expect(await io.readFile(plain)).toBe('{"a":"é"}');
    expect(writeFile).toHaveBeenCalledWith(plain, '{"a":"é"}', { encoding: 'utf8' });
    expect(chmod).not.toHaveBeenCalled();

    const secret = path.join(dir, 'secret.json');
    await io.writeFile(secret, 'x', { mode: 0o600 });
    // the data goes into a new file with the mode (flag wx) in the same folder, then over the target
    const call = vi.mocked(writeFile).mock.calls.find(([file]) => String(file) !== plain);
    expect(path.dirname(String(call?.[0]))).toBe(dir);
    expect(String(call?.[0])).not.toBe(secret);
    expect(call?.[1]).toBe('x');
    expect(call?.[2]).toEqual({ encoding: 'utf8', mode: 0o600, flag: 'wx' });
    expect(chmod).toHaveBeenCalledWith(String(call?.[0]), 0o600);
    expect(await io.readFile(secret)).toBe('x');
    await expect(io.readFile(path.join(dir, 'missing.json'))).rejects.toThrow();
  });

  it('a write with a mode over an existing file never writes into that file and leaves no temp file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wf-p6s4-io-'));
    const io = processIo();
    const target = path.join(dir, 'creds.json');
    await writeFile(target, 'old and readable', { mode: 0o644 });
    vi.mocked(writeFile).mockClear();
    await io.writeFile(target, 'secret', { mode: 0o600 });
    // no write call names the target: the old file is replaced, never filled under its old mode
    expect(vi.mocked(writeFile).mock.calls.map(([file]) => String(file))).not.toContain(target);
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ mode: 0o600, flag: 'wx' }),
    );
    expect(await io.readFile(target)).toBe('secret');
    expect(await readdir(dir)).toEqual(['creds.json']);
  });

  it('stdout and stderr write the text as is', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const io = processIo();
      io.stdout('one\n');
      io.stderr('two');
      expect(out).toHaveBeenCalledWith('one\n');
      expect(err).toHaveBeenCalledWith('two');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe('P6 S4 rewriteUuids', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const c = '33333333-3333-4333-8333-333333333333';
  const unknown = '44444444-4444-4444-8444-444444444444';
  const map = new Map([
    [a, b],
    [b, c],
  ]);
  const lookup = (id: string) => map.get(id);

  it('replaces a mapped UUID in a nested string and inside an expression; an unmapped one passes', () => {
    const input = {
      nodes: [
        { parameters: { workflowId: { value: a, mode: 'id' }, other: unknown } },
        { parameters: { code: `={{ $('x').item.json.id === "${a}" ? '${unknown}' : 1 }}` } },
      ],
      settings: { errorWorkflow: a },
      count: 3,
      flag: true,
      empty: null,
    };
    const out = rewriteUuids(input, lookup);
    const first = out.nodes[0] as { parameters: { workflowId: { value: string }; other: string } };
    const second = out.nodes[1] as { parameters: { code: string } };
    expect(first.parameters.workflowId.value).toBe(b);
    expect(first.parameters.other).toBe(unknown);
    expect(second.parameters.code).toBe(`={{ $('x').item.json.id === "${b}" ? '${unknown}' : 1 }}`);
    expect(out.settings.errorWorkflow).toBe(b);
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.empty).toBeNull();
  });

  it('leaves the input unchanged and returns copies', () => {
    const input = { list: [a, { id: a }], nested: { deep: [[a]] } };
    const before = structuredClone(input);
    const out = rewriteUuids(input, lookup);
    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.list).not.toBe(input.list);
    expect(out).toEqual({ list: [b, { id: b }], nested: { deep: [[b]] } });
  });

  it('is one pass: a replaced id is never looked up again', () => {
    expect(rewriteUuids(`${a} and ${b}`, lookup)).toBe(`${b} and ${c}`);
  });

  it('asks the lookup with the lower-case id, and leaves keys and longer hex runs alone', () => {
    const asked: string[] = [];
    const out = rewriteUuids({ [a]: a.toUpperCase(), long: `${a}0` }, (id) => {
      asked.push(id);
      return map.get(id);
    });
    expect(out).toEqual({ [a]: b, long: `${a}0` });
    expect(asked).toEqual([a]);
  });

  it('keeps an own __proto__ key as a key', () => {
    const input = JSON.parse(`{"__proto__": {"id": "${a}"}}`);
    const out = rewriteUuids(input, lookup) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    const kept = Object.getOwnPropertyDescriptor(out, '__proto__')?.value as { id: string } | undefined;
    expect(kept?.id).toBe(b);
  });
});
