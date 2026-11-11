/**
 * P6-73 (S4 L2): the workspace's Git connection and its lease.
 *
 * Connect over SSH (the fake SSH server accepts one client key, so the test stores that key as the workspace's
 * key pair before it connects; the generated key itself is checked on its own) and over HTTPS with a token (the
 * HTTP fake is plain HTTP and a token never goes over http://, so the test server's client is
 * `TlsTerminatingClient`: the real guarded client that sends an https://127.0.0.1 request as http to the fake).
 * Every remote is a fake on 127.0.0.1 in a temp folder; no test reaches the internet.
 *
 * `setReadOnly` (S4 L7) is wrapped by a spy that calls the real function, so this file stays valid once L7 fills it.
 */
import { randomBytes } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import { type HttpRequestOptions, SOURCE_CONTROL_DEFAULTS } from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceControlSettings } from '../src/db/schema';
import {
  acquireLease,
  GitLeaseLostError,
  SOURCE_CONTROL_LEASE_MS,
} from '../src/services/source-control/lock';
import {
  type BareRepo,
  createBareRepo,
  type GitHttpServer,
  type GitSshServer,
  requireGit,
  startGitHttpServer,
  startGitSshServer,
} from './fakes/git-server';
import {
  addToProject,
  createTestServer,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
} from './helpers';

const spies = vi.hoisted(() => ({ setReadOnly: vi.fn() }));
vi.mock('../src/services/protected', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/protected')>();
  spies.setReadOnly.mockImplementation(original.setReadOnly);
  return { ...original, setReadOnly: spies.setReadOnly };
});

class TlsTerminatingClient extends HttpClient {
  override request<T = unknown>(options: HttpRequestOptions, signal?: AbortSignal) {
    return super.request<T>(
      { ...options, url: options.url.replace(/^https:\/\/127\.0\.0\.1:/, 'http://127.0.0.1:') },
      signal,
    );
  }
}

const TOKEN = `tok_${randomBytes(12).toString('hex')}`;
const FILE = 'workflows/wf1/workflow.json';
let server: TestServer;
let ip = 1;
const cleanups: Array<() => Promise<void>> = [];
/** the bare repo behind a fake ssh server: tests add branch commits through it */
const repoBySsh = new WeakMap<GitSshServer, BareRepo>();

beforeAll(async () => {
  await requireGit();
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    {
      http: new TlsTerminatingClient({
        ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] },
      }),
    },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  spies.setReadOnly.mockClear();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const world = () => signup(server.app, { remoteAddress: `127.9.0.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof world>>;

async function sshRemote(): Promise<{ repo: BareRepo; ssh: GitSshServer }> {
  const repo = await createBareRepo();
  await repo.commit([{ path: FILE, data: '{}' }]);
  const ssh = await startGitSshServer(repo);
  repoBySsh.set(ssh, repo);
  cleanups.push(
    () => repo.cleanup(),
    () => ssh.close(),
  );
  return { repo, ssh };
}

async function httpRemote(
  auth?: { username: string; token: string },
  empty = false,
): Promise<{ repo: BareRepo; http: GitHttpServer; url: string }> {
  const repo = await createBareRepo();
  if (!empty) await repo.commit([{ path: FILE, data: '{}' }]);
  const http = await startGitHttpServer(repo, auth ? { auth } : {});
  cleanups.push(
    () => repo.cleanup(),
    () => http.close(),
  );
  return { repo, http, url: `https://127.0.0.1:${http.port}${repo.urlPath}` };
}

/** stores the fake server's client key as the workspace's key pair (the fake accepts only that key) */
async function useKey(w: World, key: { privateKey: string; publicKey: string }): Promise<void> {
  await server.ctx.repos.sourceControl.upsert(w.tenant.id, {
    keyType: 'ed25519',
    publicKey: key.publicKey,
    privateKeyEnc: server.ctx.cipher.encrypt(key.privateKey, {
      tenantId: w.tenant.id,
      credentialId: `sourceControl:${w.tenant.id}`,
    }),
  });
}

const rowOf = async (w: World) => (await server.ctx.repos.sourceControl.get(w.tenant.id)) ?? null;
const prefs = async (w: { client: World['client'] }) =>
  (await w.client.get('/rest/source-control/preferences')).json().data as Record<string, unknown>;
const everything = async (w: World) =>
  JSON.stringify([
    await rowOf(w),
    (await server.ctx.database.pool.query('select action, metadata from audit_log')).rows,
  ]);

describe('GET preferences', () => {
  it('makes one key pair for the manager, shows the public key and never the private key', async () => {
    const w = await world();
    const first = await prefs(w);
    expect(first).toMatchObject({
      connected: false,
      branchName: SOURCE_CONTROL_DEFAULTS.branchName,
      branchColor: SOURCE_CONTROL_DEFAULTS.branchColor,
      branchReadOnly: false,
      keyGeneratorType: 'ed25519',
    });
    expect(first.publicKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE KEY|privateKey/);
    expect((await prefs(w)).publicKey).toBe(first.publicKey);
    const row = await rowOf(w);
    expect(row?.privateKeyEnc).toBeTruthy();
    expect(row?.privateKeyEnc).not.toContain('PRIVATE KEY');
    // the cipher binding is the workspace's own
    expect(
      server.ctx.cipher.decrypt<string>(row?.privateKeyEnc ?? '', {
        tenantId: w.tenant.id,
        credentialId: `sourceControl:${w.tenant.id}`,
      }),
    ).toContain('PRIVATE KEY');
    expect(() =>
      server.ctx.cipher.decrypt(row?.privateKeyEnc ?? '', { tenantId: w.tenant.id, credentialId: 'other' }),
    ).toThrow();
  });

  it('gives a member only branchReadOnly, nothing else', async () => {
    const w = await world();
    await prefs(w);
    const member = await realMember(w);
    const answer = await prefs(member);
    expect(answer.branchReadOnly).toBe(false);
    expect(answer.connected).toBe(false);
    expect(answer.publicKey).toBeUndefined();
    expect(answer.repositoryUrl).toBeUndefined();
    expect(answer.httpsUsername).toBeUndefined();
  });

  it('keeps the first key pair when several first reads run at once (connection-2)', async () => {
    const w = await world();
    const answers = await Promise.all([prefs(w), prefs(w), prefs(w), prefs(w)]);
    const stored = (await rowOf(w))?.publicKey;
    expect(stored).toMatch(/^ssh-ed25519 /);
    for (const answer of answers) expect(answer.publicKey).toBe(stored);
  });

  it('a later first-key write never replaces a pair that is stored (connection-2)', async () => {
    const w = await world();
    const repo = server.ctx.repos.sourceControl;
    const make = (publicKey: string) => ({
      keyType: 'ed25519' as const,
      publicKey,
      privateKeyEnc: server.ctx.cipher.encrypt(`private ${publicKey}`, {
        tenantId: w.tenant.id,
        credentialId: `sourceControl:${w.tenant.id}`,
      }),
    });
    const first = await repo.upsertKeyPairIfMissing(w.tenant.id, make('ssh-ed25519 FIRST'));
    const second = await repo.upsertKeyPairIfMissing(w.tenant.id, make('ssh-ed25519 SECOND'));
    expect(first.publicKey).toBe('ssh-ed25519 FIRST');
    expect(second.publicKey).toBe('ssh-ed25519 FIRST');
    expect((await rowOf(w))?.publicKey).toBe('ssh-ed25519 FIRST');
    // a row with no key yet (an HTTPS connection saved first) still gets one
    await repo.upsert(w.tenant.id, { publicKey: null, privateKeyEnc: null });
    const third = await repo.upsertKeyPairIfMissing(w.tenant.id, make('ssh-ed25519 THIRD'));
    expect(third.publicKey).toBe('ssh-ed25519 THIRD');
  });

  it('answers a signed-out caller 401', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/rest/source-control/preferences' });
    expect(res.statusCode).toBe(401);
  });
});

describe('generate key pair', () => {
  it('regenerates with the body type, or the configured default', async () => {
    const w = await world();
    const before = (await prefs(w)).publicKey;
    const rsa = (
      await w.client.post('/rest/source-control/generate-key-pair', { keyGeneratorType: 'rsa' })
    ).json().data;
    expect(rsa.keyGeneratorType).toBe('rsa');
    expect(rsa.publicKey).toMatch(/^ssh-rsa /);
    expect(rsa.publicKey).not.toBe(before);
    const dflt = (await w.client.post('/rest/source-control/generate-key-pair', {})).json().data;
    expect(dflt.keyGeneratorType).toBe(server.ctx.config.sourceControl.defaultKeyType);
    expect(dflt.publicKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(rsa)).not.toMatch(/PRIVATE KEY/);
    const audit = (
      await server.ctx.database.pool.query(
        "select 1 from audit_log where action = 'source_control.key_generated'",
      )
    ).rowCount;
    expect(audit).toBe(2);
  });

  it('is refused while connected (the new key would not be authorised)', async () => {
    const w = await world();
    const { ssh } = await sshRemote();
    await useKey(w, ssh.clientKey);
    expect(
      (await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url })).statusCode,
    ).toBe(200);
    const res = await w.client.post('/rest/source-control/generate-key-pair', {});
    expect(res.statusCode).toBe(400);
    expect((await prefs(w)).publicKey).toBe(ssh.clientKey.publicKey);
  });

  it('makes the key again when ssh2 cannot parse the one it made (it could never sign in)', async () => {
    const w = await world();
    const real = ssh2.utils.generateKeyPairSync;
    const bad = {
      private: '-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----\n',
      public: 'ssh-ed25519 BROKEN',
    };
    const make = vi
      .spyOn(ssh2.utils, 'generateKeyPairSync')
      .mockImplementationOnce((() => bad) as unknown as typeof real);
    try {
      const res = await w.client.post('/rest/source-control/generate-key-pair', {
        keyGeneratorType: 'ed25519',
      });
      expect(res.statusCode).toBe(200);
      expect(make).toHaveBeenCalledTimes(2);
      const publicKey = res.json().data.publicKey;
      expect(publicKey).toMatch(/^ssh-ed25519 /);
      expect(publicKey).not.toBe(bad.public);
      expect(ssh2.utils.parseKey(publicKey)).not.toBeInstanceOf(Error);
    } finally {
      make.mockRestore();
    }
  });
});

describe('connect over SSH', () => {
  it('connects with the stored key, lists the branches, remembers the host key and returns no secret', async () => {
    const w = await world();
    const { repo, ssh } = await sshRemote();
    await repo.commit([{ path: FILE, data: '{"a":1}' }], { branch: 'dev' });
    await useKey(w, ssh.clientKey);
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: ssh.url,
      branchName: 'dev',
      branchColor: '#112233',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({
      connected: true,
      repositoryUrl: ssh.url,
      branchName: 'dev',
      branchColor: '#112233',
      connectionType: 'ssh',
      keyGeneratorType: 'ed25519',
      publicKey: ssh.clientKey.publicKey,
    });
    expect(res.body).not.toContain('PRIVATE KEY');
    expect((await rowOf(w))?.hostKeyFingerprint).toBe(ssh.fingerprint);
    const branches = (await w.client.get('/rest/source-control/get-branches')).json().data;
    expect(branches).toEqual({ branches: ['dev', 'main'], currentBranch: 'dev' });
    expect(ssh.commands.every((c) => /^git-upload-pack '/.test(c))).toBe(true);
    const audit = (
      await server.ctx.database.pool.query(
        "select metadata from audit_log where action = 'source_control.connected'",
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE KEY');
  });

  it('refuses a changed host key, and accepts the new one after a disconnect and a connect', async () => {
    const w = await world();
    const { ssh } = await sshRemote();
    await useKey(w, ssh.clientKey);
    expect(
      (await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url })).statusCode,
    ).toBe(200);
    const newFingerprint = ssh.swapHostKey();
    const res = await w.client.get('/rest/source-control/get-branches');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('source_control_host_key_changed');
    expect((await rowOf(w))?.hostKeyFingerprint).not.toBe(newFingerprint);
    await w.client.post('/rest/source-control/disconnect', { keepKeyPair: true });
    expect(
      (await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url })).statusCode,
    ).toBe(200);
    expect((await rowOf(w))?.hostKeyFingerprint).toBe(newFingerprint);
  });

  it('disconnects and keeps the key when the server refuses the key', async () => {
    const w = await world();
    const { ssh } = await sshRemote();
    const before = (await prefs(w)).publicKey; // the generated key: the fake does not know it
    const res = await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url });
    expect(res.statusCode).toBe(400);
    const after = await prefs(w);
    expect(after.connected).toBe(false);
    expect(after.publicKey).toBe(before);
    expect(res.body).not.toContain('PRIVATE KEY');
  });

  it('refuses a branch that is not in the repository (and disconnects)', async () => {
    const w = await world();
    const { ssh } = await sshRemote();
    await useKey(w, ssh.clientKey);
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: ssh.url,
      branchName: 'nope',
    });
    expect(res.statusCode).toBe(400);
    expect((await prefs(w)).connected).toBe(false);
  });
});

describe('connect over HTTPS', () => {
  it('connects with a token, sends it as Basic auth, stores it encrypted and never returns or audits it', async () => {
    const w = await world();
    const { http, url } = await httpRemote({ username: 'deploy', token: TOKEN });
    const logs: unknown[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(server.ctx.logger, level).mockImplementation(((...args: unknown[]) => {
        // the framework's own request lines carry raw objects here (the real logger serializes them); ours are plain
        const first = args[0] as Record<string, unknown> | undefined;
        if (first && typeof first === 'object' && ('req' in first || 'res' in first)) return;
        logs.push(args);
      }) as never);
    }
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      connectionType: 'https',
      httpsUsername: 'deploy',
      httpsPassword: TOKEN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      connected: true,
      connectionType: 'https',
      httpsUsername: 'deploy',
      branchName: 'main',
    });
    const expected = `Basic ${Buffer.from(`deploy:${TOKEN}`).toString('base64')}`;
    expect(http.requests.length).toBeGreaterThan(0);
    expect(http.requests.every((r) => r.authorization === expected)).toBe(true);
    const row = await rowOf(w);
    expect(row?.httpsPasswordEnc).toBeTruthy();
    expect(row?.httpsPasswordEnc).not.toContain(TOKEN);
    expect(
      server.ctx.cipher.decrypt(row?.httpsPasswordEnc ?? '', {
        tenantId: w.tenant.id,
        credentialId: `sourceControl:${w.tenant.id}`,
      }),
    ).toBe(TOKEN);
    const branches = await w.client.get('/rest/source-control/get-branches');
    expect(branches.json().data.branches).toEqual(['main']);
    for (const body of [
      res.body,
      branches.body,
      JSON.stringify(await prefs(w)),
      await everything(w),
      JSON.stringify(logs),
    ]) {
      expect(body).not.toContain(TOKEN);
    }
    vi.restoreAllMocks();
  });

  it('does not keep a token after a disconnect: a blank token is refused', async () => {
    const w = await world();
    const { http, url } = await httpRemote({ username: 'deploy', token: TOKEN });
    await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      httpsUsername: 'deploy',
      httpsPassword: TOKEN,
    });
    await w.client.post('/rest/source-control/disconnect', { keepKeyPair: true });
    // the disconnect dropped the connection and its token: a blank token is refused, not guessed
    const refused = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      connectionType: 'https',
      httpsUsername: 'deploy',
    });
    expect(refused.statusCode).toBe(400);
    expect(http.requests.length).toBeGreaterThan(0);
  });

  it('answers a wrong token with a refusal and ends disconnected', async () => {
    const w = await world();
    const { url } = await httpRemote({ username: 'deploy', token: TOKEN });
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      connectionType: 'https',
      httpsUsername: 'deploy',
      httpsPassword: 'wrong-token-value',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('wrong-token-value');
    expect((await prefs(w)).connected).toBe(false);
    expect((await rowOf(w))?.httpsPasswordEnc ?? null).toBeNull();
  });

  it('refuses a token for a plain http:// URL, and a missing token for https://', async () => {
    const w = await world();
    const plain = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: 'http://127.0.0.1:9/repo.git',
      connectionType: 'https',
      httpsPassword: TOKEN,
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.body).not.toContain(TOKEN);
    const missing = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: 'https://127.0.0.1:9/repo.git',
      connectionType: 'https',
    });
    expect(missing.statusCode).toBe(400);
  });

  it('connects a plain http:// remote without a token', async () => {
    const w = await world();
    const { http } = await httpRemote();
    const res = await w.client.post('/rest/source-control/preferences', { repositoryUrl: http.url });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ connected: true, connectionType: 'https' });
  });
});

describe('remote URL and body rules', () => {
  it.each([
    'file:///tmp/repo.git',
    'ext::sh -c id',
    'git://example.com/repo.git',
    'ssh://git@example.com/repo.git; id',
    '',
  ])('refuses the URL %j', async (repositoryUrl) => {
    const w = await world();
    const res = await w.client.post('/rest/source-control/preferences', { repositoryUrl });
    expect(res.statusCode).toBe(400);
    expect((await prefs(w)).connected).toBe(false);
  });

  it('refuses a connect with no URL, a branch that does not start with a letter or digit, and a bad colour', async () => {
    const w = await world();
    expect((await w.client.post('/rest/source-control/preferences', {})).statusCode).toBe(400);
    for (const branchName of ['-x', '.hidden', '/main', '..']) {
      const res = await w.client.post('/rest/source-control/preferences', {
        repositoryUrl: 'ssh://git@127.0.0.1:9/repo.git',
        branchName,
      });
      expect(res.statusCode).toBe(400);
    }
    const colour = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: 'ssh://git@127.0.0.1:9/repo.git',
      branchColor: 'red',
    });
    expect(colour.statusCode).toBe(400);
  });

  it('refuses an SSH URL with a token connection and an https URL with an SSH connection', async () => {
    const w = await world();
    const a = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: 'ssh://git@127.0.0.1:9/repo.git',
      connectionType: 'https',
      httpsPassword: TOKEN,
    });
    expect(a.statusCode).toBe(400);
    const b = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: 'https://127.0.0.1:9/repo.git',
      connectionType: 'ssh',
    });
    expect(b.statusCode).toBe(400);
  });
});

describe('initRepo', () => {
  it('pushes a first commit on an empty repository', async () => {
    const w = await world();
    const { repo, url } = await httpRemote({ username: 'deploy', token: TOKEN }, true);
    expect(await repo.head()).toBeNull();
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      httpsUsername: 'deploy',
      httpsPassword: TOKEN,
      initRepo: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.connected).toBe(true);
    const head = await repo.head();
    expect(head).toBeTruthy();
    expect(await repo.parents(head as string)).toEqual([]);
    await repo.fsck();
  });

  it('refuses an empty repository without initRepo', async () => {
    const w = await world();
    const { repo, url } = await httpRemote({ username: 'deploy', token: TOKEN }, true);
    const res = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: url,
      httpsUsername: 'deploy',
      httpsPassword: TOKEN,
    });
    expect(res.statusCode).toBe(400);
    expect(await repo.head()).toBeNull();
    expect((await prefs(w)).connected).toBe(false);
  });
});

describe('permissions', () => {
  it('lets only sourceControl:manage change anything', async () => {
    const w = await world();
    const member = await realMember(w);
    const calls: Array<[string, string, unknown?]> = [
      ['post', '/rest/source-control/preferences', { repositoryUrl: 'ssh://git@127.0.0.1:9/r.git' }],
      ['patch', '/rest/source-control/preferences', { branchColor: '#112233' }],
      ['post', '/rest/source-control/preferences', { branchReadOnly: true }],
      ['post', '/rest/source-control/disconnect', {}],
      ['post', '/rest/source-control/generate-key-pair', {}],
      ['get', '/rest/source-control/get-branches'],
    ];
    for (const [method, url, body] of calls) {
      const res = await (
        member.client as never as Record<string, (u: string, b?: unknown) => Promise<{ statusCode: number }>>
      )[method](url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(spies.setReadOnly).not.toHaveBeenCalled();
    expect(await rowOf(w)).toBeNull();
  });
});

describe('while connected', () => {
  async function connected() {
    const w = await world();
    const { ssh } = await sshRemote();
    await useKey(w, ssh.clientKey);
    expect(
      (await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url })).statusCode,
    ).toBe(200);
    return { w, ssh };
  }

  it('refuses POST unless it sends only branchReadOnly, which calls setReadOnly', async () => {
    const { w, ssh } = await connected();
    spies.setReadOnly.mockClear();
    const refused = await w.client.post('/rest/source-control/preferences', {
      repositoryUrl: ssh.url,
      branchName: 'main',
    });
    expect(refused.statusCode).toBe(400);
    expect(spies.setReadOnly).not.toHaveBeenCalled();
    const ok = await w.client.post('/rest/source-control/preferences', { branchReadOnly: true });
    expect(ok.statusCode).toBe(200);
    expect(spies.setReadOnly).toHaveBeenCalledTimes(1);
    expect(spies.setReadOnly.mock.calls[0]?.[2]).toBe(true);
  });

  it('PATCH changes the colour and the branch (which must exist) and calls setReadOnly', async () => {
    const { w, ssh } = await connected();
    const repo = await sshRemoteRepoOf(ssh);
    await repo.commit([{ path: FILE, data: '{"b":1}' }], { branch: 'staging' });
    spies.setReadOnly.mockClear();
    const res = await w.client.patch('/rest/source-control/preferences', {
      branchName: 'staging',
      branchColor: '#AABBCC',
      branchReadOnly: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ branchName: 'staging', branchColor: '#AABBCC', connected: true });
    expect(spies.setReadOnly).toHaveBeenCalledTimes(1);
    expect(spies.setReadOnly.mock.calls[0]?.[2]).toBe(false);
    const missing = await w.client.patch('/rest/source-control/preferences', { branchName: 'gone' });
    expect(missing.statusCode).toBe(400);
    expect((await prefs(w)).branchName).toBe('staging');
    expect(
      (await w.client.patch('/rest/source-control/preferences', { branchColor: 'blue' })).statusCode,
    ).toBe(400);
    expect(
      (await w.client.patch('/rest/source-control/preferences', { branchName: '-bad' })).statusCode,
    ).toBe(400);
  });

  it('a project admin sees connected, the branch and the colour, never the URL, the key or the user (connection-3)', async () => {
    const { w, ssh } = await connected();
    const colour = await w.client.patch('/rest/source-control/preferences', { branchColor: '#112233' });
    expect(colour.statusCode).toBe(200);
    const admin = await realMember(w);
    const project = await teamProjectOf(server, w.tenant.id);
    await addToProject(server, w.tenant.id, project, admin.user.id, 'project:admin');
    const answer = await prefs(admin);
    expect(answer).toMatchObject({ connected: true, branchName: 'main', branchColor: '#112233' });
    expect(answer.branchReadOnly).toBe(false);
    expect(answer.publicKey).toBeUndefined();
    expect(answer.repositoryUrl).toBeUndefined();
    expect(answer.connectionType).toBeUndefined();
    expect(answer.httpsUsername).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain(ssh.url);
  });

  it('a member with no pushable project sees not connected and the default branch (connection-3)', async () => {
    const { w } = await connected();
    const colour = await w.client.patch('/rest/source-control/preferences', { branchColor: '#112233' });
    expect(colour.statusCode).toBe(200);
    const member = await realMember(w);
    const answer = await prefs(member);
    expect(answer).toMatchObject({
      connected: false,
      branchName: SOURCE_CONTROL_DEFAULTS.branchName,
      branchColor: SOURCE_CONTROL_DEFAULTS.branchColor,
      branchReadOnly: false,
    });
    expect(answer.publicKey).toBeUndefined();
    expect(answer.repositoryUrl).toBeUndefined();
    expect(answer.httpsUsername).toBeUndefined();
  });

  it('disconnect answers 409 source_control_busy while an operation holds the lease and keeps the connection (connection-1)', async () => {
    const { w, ssh } = await connected();
    const lease = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    for (const body of [{ keepKeyPair: true }, {}]) {
      const refused = await w.client.post('/rest/source-control/disconnect', body);
      expect(refused.statusCode).toBe(409);
      expect(JSON.stringify(refused.json())).toContain('source_control_busy');
      const row = await rowOf(w);
      expect(row?.connected).toBe(true);
      expect(row?.repositoryUrl).toBe(ssh.url);
      // the holder keeps its lease: a second operation is still refused and the holder can extend
      await expect(acquireLease(server.ctx.serviceDeps, w.tenant.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      await lease.extend();
    }
    await lease.release();
    const ok = await w.client.post('/rest/source-control/disconnect', { keepKeyPair: true });
    expect(ok.statusCode).toBe(200);
    expect((await rowOf(w))?.lockedUntil ?? null).toBeNull();
    expect((await rowOf(w))?.connected).toBe(false);
  });

  it('disconnect works on a workspace with no row, and an expired lease does not block it', async () => {
    const fresh = await world();
    expect((await fresh.client.post('/rest/source-control/disconnect', {})).statusCode).toBe(200);
    const { w } = await connected();
    await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    await server.ctx.database.pool.query(
      "update source_control_settings set locked_until = now() - interval '1 minute' where tenant_id = $1",
      [w.tenant.id],
    );
    expect((await w.client.post('/rest/source-control/disconnect', {})).statusCode).toBe(200);
  });

  it('PATCH with a branch name answers 409 source_control_busy while an operation holds the lease', async () => {
    const { w, ssh } = await connected();
    const repo = await sshRemoteRepoOf(ssh);
    await repo.commit([{ path: FILE, data: '{"b":2}' }], { branch: 'staging' });
    const lease = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    const busy = await w.client.patch('/rest/source-control/preferences', { branchName: 'staging' });
    expect(busy.statusCode).toBe(409);
    expect(JSON.stringify(busy.json())).toContain('source_control_busy');
    expect((await rowOf(w))?.branchName).toBe('main');
    // the colour needs no lease
    const colour = await w.client.patch('/rest/source-control/preferences', { branchColor: '#010203' });
    expect(colour.statusCode).toBe(200);
    await lease.release();
    const ok = await w.client.patch('/rest/source-control/preferences', { branchName: 'staging' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.branchName).toBe('staging');
    // the PATCH released its own lease, also when it fails
    expect((await rowOf(w))?.lockedUntil ?? null).toBeNull();
    const missing = await w.client.patch('/rest/source-control/preferences', { branchName: 'gone' });
    expect(missing.statusCode).toBe(400);
    expect((await rowOf(w))?.lockedUntil ?? null).toBeNull();
  });

  it('disconnect clears the connection, drops or keeps the key pair, and calls setReadOnly(false)', async () => {
    const { w, ssh } = await connected();
    spies.setReadOnly.mockClear();
    const kept = await w.client.post('/rest/source-control/disconnect', { keepKeyPair: true });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().data).toMatchObject({ connected: false, publicKey: ssh.clientKey.publicKey });
    expect((await rowOf(w))?.repositoryUrl ?? null).toBeNull();
    expect(spies.setReadOnly).toHaveBeenCalledTimes(1);
    expect(spies.setReadOnly.mock.calls[0]?.[2]).toBe(false);
    // connect again, then drop the pair
    expect(
      (await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url })).statusCode,
    ).toBe(200);
    const dropped = await w.client.post('/rest/source-control/disconnect', {});
    expect(dropped.json().data.connected).toBe(false);
    expect(dropped.json().data.publicKey).not.toBe(ssh.clientKey.publicKey);
    expect((await w.client.get('/rest/source-control/get-branches')).statusCode).toBe(412);
    const audit = (
      await server.ctx.database.pool.query(
        "select 1 from audit_log where action = 'source_control.disconnected'",
      )
    ).rowCount;
    expect(audit).toBe(2);
  });

  it('answers get-branches with 412 source_control_not_connected before a connect', async () => {
    const w = await world();
    const res = await w.client.get('/rest/source-control/get-branches');
    expect(res.statusCode).toBe(412);
    expect(JSON.stringify(res.json())).toContain('source_control_not_connected');
  });
});

async function sshRemoteRepoOf(ssh: GitSshServer): Promise<BareRepo> {
  const repo = repoBySsh.get(ssh);
  if (!repo) throw new Error('unknown ssh fake');
  return repo;
}

describe('the lease', () => {
  async function connectedWorld() {
    const w = await world();
    const { ssh } = await sshRemote();
    await useKey(w, ssh.clientKey);
    await w.client.post('/rest/source-control/preferences', { repositoryUrl: ssh.url });
    return w;
  }
  const lockedUntil = async (w: World) => (await rowOf(w))?.lockedUntil ?? null;
  const expire = async (w: World) => {
    await server.ctx.database.pool.query(
      "update source_control_settings set locked_until = now() - interval '1 minute' where tenant_id = $1",
      [w.tenant.id],
    );
  };

  it('is refused before a connect with 412', async () => {
    const w = await world();
    await expect(acquireLease(server.ctx.serviceDeps, w.tenant.id)).rejects.toMatchObject({
      statusCode: 412,
    });
  });

  it('gives the lease to one caller; the second gets 409 until the first releases', async () => {
    const w = await connectedWorld();
    const a = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    const until = await lockedUntil(w);
    expect(until).not.toBeNull();
    const ms = (until as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(SOURCE_CONTROL_LEASE_MS - 15_000);
    expect(ms).toBeLessThanOrEqual(SOURCE_CONTROL_LEASE_MS);
    expect((until as Date).getTime() % 1).toBe(0);
    await expect(acquireLease(server.ctx.serviceDeps, w.tenant.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await a.release();
    expect(await lockedUntil(w)).toBeNull();
    const b = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    await b.release();
  });

  it('extend moves the lease on while the holder still has it', async () => {
    const w = await connectedWorld();
    const a = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    const first = (await lockedUntil(w)) as Date;
    await new Promise((r) => setTimeout(r, 20));
    await a.extend();
    const second = (await lockedUntil(w)) as Date;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    await a.release();
  });

  it("an expired lease can be taken; the first holder's release leaves it and its extend throws", async () => {
    const w = await connectedWorld();
    const a = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    await expire(w);
    const b = await acquireLease(server.ctx.serviceDeps, w.tenant.id);
    const held = (await lockedUntil(w)) as Date;
    await a.release();
    expect((await lockedUntil(w))?.getTime()).toBe(held.getTime());
    await expect(a.extend()).rejects.toBeInstanceOf(GitLeaseLostError);
    await expect(a.extend()).rejects.toMatchObject({ statusCode: 409 });
    expect((await lockedUntil(w))?.getTime()).toBe(held.getTime());
    await b.extend();
    await b.release();
    expect(await lockedUntil(w)).toBeNull();
  });

  it("another workspace's settings and lease are untouched", async () => {
    const a = await connectedWorld();
    const b = await connectedWorld();
    const leaseA = await acquireLease(server.ctx.serviceDeps, a.tenant.id);
    expect(await lockedUntil(b)).toBeNull();
    const leaseB = await acquireLease(server.ctx.serviceDeps, b.tenant.id);
    await leaseA.release();
    expect(await lockedUntil(b)).not.toBeNull();
    expect((await prefs(b)).connected).toBe(true);
    const rows = await server.ctx.database.db
      .select()
      .from(sourceControlSettings)
      .where(and(eq(sourceControlSettings.tenantId, b.tenant.id), eq(sourceControlSettings.connected, true)));
    expect(rows).toHaveLength(1);
    await leaseB.release();
  });
});

describe('two workspaces', () => {
  it('keeps each connection to its own workspace', async () => {
    const a = await world();
    const b = await world();
    const { ssh } = await sshRemote();
    await useKey(a, ssh.clientKey);
    await a.client.post('/rest/source-control/preferences', {
      repositoryUrl: ssh.url,
      branchColor: '#010203',
    });
    const pa = await prefs(a);
    const pb = await prefs(b);
    expect(pa.connected).toBe(true);
    expect(pb.connected).toBe(false);
    expect(pb.branchColor).toBe(SOURCE_CONTROL_DEFAULTS.branchColor);
    expect(pb.publicKey).not.toBe(pa.publicKey);
    await b.client.post('/rest/source-control/disconnect', {});
    expect((await prefs(a)).connected).toBe(true);
  });
});
