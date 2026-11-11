/**
 * P6-72 (S4 L1): the Git transports against local fakes (test/fakes/git-server.ts) on 127.0.0.1; no test reaches
 * the internet and no real token or key is used.
 * Step 1 (the spike, plan-S4.md section 7 note 5): a push over SSH on top of a `depth: 1` fetch, through the
 * SSH adapter and isomorphic-git (fetch, writeTree, writeCommit, push). Then `withRepo` over SSH and HTTP: fetch,
 * push, list branches, the response cap, private hosts, redirects, the token rules, host key memory and the temp
 * folder.
 *
 * The HTTP fake is plain HTTP, and a token is never sent over http://. For the token cases the test uses
 * `TlsTerminatingClient`: the real guarded client, except that it sends an `https://127.0.0.1` request as http to
 * the fake (the part a TLS proxy would do); the allow list, redirect and domain checks all still run.
 */
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { type HttpRequestOptions, SOURCE_CONTROL_LIMITS } from '@workflow/workflow';
import git from 'isomorphic-git';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  GitAuthError,
  type GitDeps,
  GitHostKeyChangedError,
  GitLimitError,
  GitRemoteError,
  type GitSession,
  withRepo,
} from '../src/services/source-control/git-repo';
import { gitHttpTransport } from '../src/services/source-control/transport-http';
import { gitSshTransport, type HostKeyCheck } from '../src/services/source-control/transport-ssh';
import { parseRemoteUrl } from '../src/services/source-control/url';
import {
  type BareRepo,
  createBareRepo,
  type GitHttpServer,
  type GitSshServer,
  generateSshKey,
  requireGit,
  startGitHttpServer,
  startGitSshServer,
} from './fakes/git-server';

const WF = 'workflows/0b7c2f1e-4a55-4c1e-9d3e-2f1a7b6c5d4e.json';
const WF2 = 'workflows/7d1e2f3a-9b8c-4d5e-8f6a-1b2c3d4e5f60.json';
const TOKEN = 'test-token-not-real-123';
const AUTHOR = { name: 'Workflow', email: 'workflow@example.test' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

beforeAll(async () => {
  expect(await requireGit()).toMatch(/^git version/);
});

/** a client that may reach the fakes on 127.0.0.1 */
const localClient = () => new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });

async function sshFixture(): Promise<{ repo: BareRepo; server: GitSshServer }> {
  const repo = await createBareRepo();
  const server = await startGitSshServer(repo);
  cleanups.push(
    () => repo.cleanup(),
    () => server.close(),
  );
  return { repo, server };
}

function memoryHostKey(initial: string | null = null): HostKeyCheck & { seen: string[] } {
  const check = {
    fingerprint: initial,
    seen: [] as string[],
    async onFirstSeen(fingerprint: string) {
      check.seen.push(fingerprint);
      check.fingerprint = fingerprint;
    },
  };
  return check;
}

describe('spike: push over SSH on top of a depth: 1 fetch', () => {
  it('fetches the bare repo over SSH, commits on the shallow head and pushes it', async () => {
    const { repo, server } = await sshFixture();
    const first = await repo.commit([{ path: WF, data: '{"v":1}' }], { message: 'one' });
    const second = await repo.commit(
      [
        { path: WF, data: '{"v":2}' },
        { path: 'tags.json', data: '[]' },
      ],
      {
        message: 'two',
      },
    );
    expect(await repo.parents(second)).toEqual([first]);

    const gitdir = await mkdtemp(path.join(os.tmpdir(), 'wf-spike-'));
    cleanups.push(() => rm(gitdir, { recursive: true, force: true }));
    const remote = parseRemoteUrl(server.url);
    const hostKey = memoryHostKey();
    const transport = gitSshTransport(
      localClient(),
      remote,
      { privateKey: server.clientKey.privateKey },
      hostKey,
    );
    try {
      await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
      const url = 'https://ssh.invalid/repo.git';
      await git.addRemote({ fs, gitdir, remote: 'origin', url });
      const fetched = await git.fetch({
        fs,
        http: transport,
        gitdir,
        url,
        ref: 'main',
        singleBranch: true,
        depth: 1,
        tags: false,
      });
      expect(fetched.fetchHead).toBe(second);
      expect(hostKey.seen).toEqual([server.fingerprint]);

      const { commit } = await git.readCommit({ fs, gitdir, oid: second });
      // depth 1: the parent is not in the store
      await expect(git.readCommit({ fs, gitdir, oid: first })).rejects.toThrow();

      const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from('{"v":3}') });
      const old = await git.readTree({ fs, gitdir, oid: commit.tree });
      const folder = old.tree.find((e) => e.path === 'workflows');
      const sub = await git.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '100644', path: path.posix.basename(WF), oid: blob, type: 'blob' }],
      });
      const tree = await git.writeTree({
        fs,
        gitdir,
        tree: old.tree.map((e) => (e === folder ? { ...e, oid: sub } : e)),
      });
      const now = Math.floor(Date.now() / 1000);
      const author = { name: 'Spike', email: 'spike@example.test', timestamp: now, timezoneOffset: 0 };
      const third = await git.writeCommit({
        fs,
        gitdir,
        commit: { message: 'three\n', tree, parent: [second], author, committer: author },
      });
      await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: third, force: true });
      const pushed = await git.push({ fs, http: transport, gitdir, url, ref: 'main', remoteRef: 'main' });
      expect(pushed.ok).toBe(true);
    } finally {
      await transport.close();
    }

    const head = await repo.head('main');
    expect(head).not.toBe(second);
    expect(await repo.parents(String(head))).toEqual([second]);
    expect((await repo.files(String(head))).get(WF)).toBe('{"v":3}');
    expect(server.commands).toEqual(["git-upload-pack '/repo.git'", "git-receive-pack '/repo.git'"]);
  });
});

/** the guarded client, except that an https://127.0.0.1 request goes to the plain HTTP fake (see the head comment) */
class TlsTerminatingClient extends HttpClient {
  override request<T = unknown>(options: HttpRequestOptions, signal?: AbortSignal) {
    return super.request<T>(
      { ...options, url: options.url.replace(/^https:\/\/127\.0\.0\.1:/, 'http://127.0.0.1:') },
      signal,
    );
  }
}

const deps = (http: HttpClient = localClient()): GitDeps => ({ http, limits: SOURCE_CONTROL_LIMITS });

async function httpFixture(
  options: Parameters<typeof startGitHttpServer>[1] = {},
): Promise<{ repo: BareRepo; server: GitHttpServer }> {
  const repo = await createBareRepo();
  const server = await startGitHttpServer(repo, options);
  cleanups.push(
    () => repo.cleanup(),
    () => server.close(),
  );
  return { repo, server };
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** fetch, read, commit one changed file on the head and push: what a push of the sync service does */
async function roundTrip(repo: GitSession, value: string): Promise<{ before: string | null; after: string }> {
  const before = await repo.fetchBranch('main');
  const files = before ? await repo.readFiles(before) : new Map<string, Uint8Array>();
  files.set(WF, bytes(value));
  const after = await repo.writeCommit({ parent: before, files, message: `set ${value}`, author: AUTHOR });
  await repo.push('main', after, { force: false });
  return { before, after };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('withRepo over SSH', () => {
  it('fetches, reads, commits on a depth 1 head and pushes; host key accepted once', async () => {
    const { repo, server } = await sshFixture();
    const seed = await repo.commit([
      { path: WF, data: '{"v":1}' },
      { path: 'tags.json', data: '[]' },
    ]);
    const hostKey = memoryHostKey();
    const remote = {
      url: server.url,
      auth: { kind: 'ssh' as const, privateKey: server.clientKey.privateKey, hostKey },
    };
    const { before, after } = await withRepo(deps(), remote, (session) => roundTrip(session, '{"v":2}'));
    expect(before).toBe(seed);
    expect(await repo.head()).toBe(after);
    expect(await repo.parents(after)).toEqual([seed]);
    expect(Object.fromEntries(await repo.files(after))).toEqual({ [WF]: '{"v":2}', 'tags.json': '[]' });
    expect(await repo.message(after)).toBe('set {"v":2}');
    expect(hostKey.seen).toEqual([server.fingerprint]);

    // a second operation with the stored key: no new first-seen call
    const branches = await withRepo(deps(), remote, (session) => session.listBranches());
    expect(branches).toEqual(['main']);
    expect(hostKey.seen).toHaveLength(1);
    // the only commands ever run: the two service names with the quoted path
    for (const command of server.commands) {
      expect(command).toMatch(/^git-(upload|receive)-pack '\/repo\.git'$/);
    }
  });

  it('pushes the first commit to an empty repository (scp form URL path)', async () => {
    const { repo, server } = await sshFixture();
    const remote = {
      url: `ssh://git@127.0.0.1:${server.port}/repo.git`,
      auth: { kind: 'ssh' as const, privateKey: server.clientKey.privateKey, hostKey: memoryHostKey() },
    };
    const { before, after } = await withRepo(deps(), remote, (session) =>
      roundTrip(session, '{"first":true}'),
    );
    expect(before).toBeNull();
    expect(await repo.head()).toBe(after);
    expect(await repo.parents(after)).toEqual([]);
  });

  it('pushes a new branch and lists branches', async () => {
    const { repo, server } = await sshFixture();
    const seed = await repo.commit([{ path: WF, data: '{}' }]);
    await repo.commit([{ path: WF, data: '{"b":1}' }], { branch: 'feature/one' });
    const remote = {
      url: server.url,
      auth: { kind: 'ssh' as const, privateKey: server.clientKey.privateKey, hostKey: memoryHostKey() },
    };
    const listed = await withRepo(deps(), remote, async (session) => {
      const before = await session.listBranches();
      const head = await session.fetchBranch('main');
      const commit = await session.writeCommit({
        parent: head,
        files: new Map([[WF2, bytes('{"two":2}')]]),
        message: 'new branch',
        author: AUTHOR,
      });
      await session.push('release', commit, { force: false });
      return { before, after: await session.listBranches(), missing: await session.fetchBranch('nope') };
    });
    expect(listed.before).toEqual(['feature/one', 'main']);
    expect(listed.after).toEqual(['feature/one', 'main', 'release']);
    expect(listed.missing).toBeNull();
    expect(await repo.parents(String(await repo.head('release')))).toEqual([seed]);
  });

  it('refuses a changed host key and keeps the stored one', async () => {
    const { repo, server } = await sshFixture();
    await repo.commit([{ path: WF, data: '{}' }]);
    const hostKey = memoryHostKey();
    const remote = {
      url: server.url,
      auth: { kind: 'ssh' as const, privateKey: server.clientKey.privateKey, hostKey },
    };
    await withRepo(deps(), remote, (session) => session.listBranches());
    const first = hostKey.fingerprint;
    expect(first).toBe(server.fingerprint);

    const swapped = server.swapHostKey();
    expect(swapped).not.toBe(first);
    const error = await rejection(withRepo(deps(), remote, (session) => session.listBranches()));
    expect(error).toBeInstanceOf(GitHostKeyChangedError);
    expect(error.message).toMatch(/Disconnect and connect again/);
    expect(hostKey.fingerprint).toBe(first);
    expect(hostKey.seen).toEqual([first]);
  });

  it('refuses a key the server does not accept', async () => {
    const { repo, server } = await sshFixture();
    await repo.commit([{ path: WF, data: '{}' }]);
    const other = generateSshKey();
    const error = await rejection(
      withRepo(
        deps(),
        { url: server.url, auth: { kind: 'ssh', privateKey: other.privateKey, hostKey: memoryHostKey() } },
        (session) => session.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitAuthError);
    expect(error.message).not.toContain('PRIVATE KEY');
  });

  it('refuses a private host before any socket opens (a client with no allow list)', async () => {
    const { server } = await sshFixture();
    const hostKey = memoryHostKey();
    const error = await rejection(
      withRepo(
        deps(new HttpClient()),
        { url: server.url, auth: { kind: 'ssh', privateKey: server.clientKey.privateKey, hostKey } },
        (session) => session.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.message).toMatch(/not allowed by the network policy/);
    expect(server.connections).toBe(0);
    expect(hostKey.seen).toEqual([]);
  });

  it('a repository path the server does not serve fails with a remote error', async () => {
    const { server } = await sshFixture();
    const error = await rejection(
      withRepo(
        deps(),
        {
          url: `ssh://git@127.0.0.1:${server.port}/other.git`,
          auth: { kind: 'ssh', privateKey: server.clientKey.privateKey, hostKey: memoryHostKey() },
        },
        (session) => session.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(server.commands).toEqual(["git-upload-pack '/other.git'"]);
  });

  it('gitSshTransport refuses a non-SSH remote', () => {
    expect(() =>
      gitSshTransport(
        localClient(),
        parseRemoteUrl('https://127.0.0.1/r.git'),
        { privateKey: 'x' },
        memoryHostKey(),
      ),
    ).toThrow(GitRemoteError);
  });
});

describe('withRepo over HTTP', () => {
  it('fetches, commits on a depth 1 head and pushes over Smart HTTP v1 (no token, http://)', async () => {
    const { repo, server } = await httpFixture();
    const seed = await repo.commit([{ path: WF, data: '{"v":1}' }]);
    const next = await repo.commit([
      { path: WF, data: '{"v":2}' },
      { path: 'folders.json', data: '[]' },
    ]);
    const { before, after } = await withRepo(
      deps(),
      { url: server.url, auth: { kind: 'https', username: '', token: '' } },
      (session) => roundTrip(session, '{"v":3}'),
    );
    expect(before).toBe(next);
    expect(await repo.head()).toBe(after);
    expect(await repo.parents(after)).toEqual([next]);
    expect(await repo.parents(next)).toEqual([seed]);
    expect(Object.fromEntries(await repo.files(after))).toEqual({ [WF]: '{"v":3}', 'folders.json': '[]' });
    // protocol v1 only, and no Authorization header without a token
    expect(server.requests.length).toBeGreaterThanOrEqual(4);
    for (const request of server.requests) {
      expect(request.gitProtocol).toBeUndefined();
      expect(request.authorization).toBeUndefined();
    }
  });

  it('sends the token as Basic auth over https only, to the remote host', async () => {
    const { repo, server } = await httpFixture({ auth: { username: 'deploy', token: TOKEN } });
    await repo.commit([{ path: WF, data: '{}' }]);
    const url = `https://127.0.0.1:${server.port}/repo.git`;
    const { after } = await withRepo(
      deps(new TlsTerminatingClient({ ssrf: { allow: ['127.0.0.1'] } })),
      { url, auth: { kind: 'https', username: 'deploy', token: TOKEN } },
      (session) => roundTrip(session, '{"token":true}'),
    );
    expect(await repo.head()).toBe(after);
    const expected = `Basic ${Buffer.from(`deploy:${TOKEN}`).toString('base64')}`;
    expect(server.requests.every((r) => r.authorization === expected)).toBe(true);
  });

  it('maps a refused token to GitAuthError with no secret in the text', async () => {
    const { repo, server } = await httpFixture({ auth: { username: 'deploy', token: TOKEN } });
    await repo.commit([{ path: WF, data: '{}' }]);
    const error = await rejection(
      withRepo(
        deps(new TlsTerminatingClient({ ssrf: { allow: ['127.0.0.1'] } })),
        {
          url: `https://127.0.0.1:${server.port}/repo.git`,
          auth: { kind: 'https', username: 'deploy', token: 'wrong-token-value' },
        },
        (session) => session.fetchBranch('main'),
      ),
    );
    expect(error).toBeInstanceOf(GitAuthError);
    expect(error.message).not.toContain('wrong-token-value');
  });

  it('never sends a token over plain http://', async () => {
    const { server } = await httpFixture();
    const error = await rejection(
      withRepo(deps(), { url: server.url, auth: { kind: 'https', username: 'u', token: TOKEN } }, (session) =>
        session.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.message).toMatch(/never sent over plain http/);
    expect(error.message).not.toContain(TOKEN);
    expect(server.requests).toEqual([]);
    expect(() =>
      gitHttpTransport(localClient(), parseRemoteUrl(server.url), { username: 'u', token: TOKEN }),
    ).toThrow(/never sent over plain http/);
  });

  it('lists branches', async () => {
    const { repo, server } = await httpFixture();
    await repo.commit([{ path: WF, data: '{}' }]);
    await repo.commit([{ path: WF, data: '{}' }], { branch: 'dev' });
    await repo.commit([{ path: WF, data: '{}' }], { branch: 'team/prod' });
    const branches = await withRepo(
      deps(),
      { url: server.url, auth: { kind: 'https', username: '', token: '' } },
      (s) => s.listBranches(),
    );
    expect(branches).toEqual(['dev', 'main', 'team/prod']);
  });

  it("refuses an answer over the client's maxResponseBytes", async () => {
    const { repo, server } = await httpFixture();
    // random data does not compress: the pack is larger than the 16 KiB cap
    const big = Array.from({ length: 4096 }, () => Math.random().toString(36).slice(2, 10)).join('');
    await repo.commit([{ path: WF, data: big }]);
    const small = new HttpClient({ ssrf: { allow: ['127.0.0.1'] }, maxResponseBytes: 16 * 1024 });
    const error = await rejection(
      withRepo(deps(small), { url: server.url, auth: { kind: 'https', username: '', token: '' } }, (s) =>
        s.fetchBranch('main'),
      ),
    );
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/size limit/);
  });

  it('refuses a private host before any request (a client with no allow list)', async () => {
    const { server } = await httpFixture();
    const error = await rejection(
      withRepo(
        deps(new HttpClient()),
        { url: server.url, auth: { kind: 'https', username: '', token: '' } },
        (s) => s.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.message).toMatch(/not allowed by the network policy/);
    expect(server.requests).toEqual([]);
  });

  it('refuses a redirect to a private address', async () => {
    const target = await httpFixture();
    // 127.0.0.2 is loopback too, and not on the test client's allow list
    const { server } = await httpFixture({ redirectTo: `http://127.0.0.2:${target.server.port}` });
    const error = await rejection(
      withRepo(deps(), { url: server.url, auth: { kind: 'https', username: '', token: '' } }, (s) =>
        s.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.message).toMatch(/not allowed by the network policy/);
    expect(server.requests).toHaveLength(1);
    expect(target.server.requests).toEqual([]);
  });

  it('a redirect to another host gets no token', async () => {
    const other = await httpFixture();
    const { server } = await httpFixture({ redirectTo: `http://localhost:${other.server.port}` });
    const error = await rejection(
      withRepo(
        deps(new TlsTerminatingClient({ ssrf: { allow: ['127.0.0.1', 'localhost', '::1'] } })),
        {
          url: `https://127.0.0.1:${server.port}/repo.git`,
          auth: { kind: 'https', username: 'deploy', token: TOKEN },
        },
        (s) => s.listBranches(),
      ),
    );
    expect(error).toBeInstanceOf(GitRemoteError);
    expect(error.message).toMatch(/redirected to another host/);
    expect(error.message).not.toContain(TOKEN);
    expect(server.requests).toHaveLength(1);
    expect(other.server.requests).toEqual([]);
  });

  it('refuses a key with an https URL and a token with an SSH URL', async () => {
    await expect(
      withRepo(
        deps(),
        { url: 'https://127.0.0.1/r.git', auth: { kind: 'ssh', privateKey: 'k', hostKey: memoryHostKey() } },
        async () => 1,
      ),
    ).rejects.toThrow(/SSH key needs/);
    await expect(
      withRepo(
        deps(),
        { url: 'git@127.0.0.1:r.git', auth: { kind: 'https', username: 'u', token: 't' } },
        async () => 1,
      ),
    ).rejects.toThrow(/token needs an https/);
    await expect(
      withRepo(
        deps(),
        { url: 'file:///etc', auth: { kind: 'https', username: '', token: '' } },
        async () => 1,
      ),
    ).rejects.toMatchObject({ code: 'source_control_url' });
  });
});

describe('withRepo temp folder', () => {
  /** the temp folders whose origin URL is `url` */
  async function foldersFor(url: string): Promise<string[]> {
    const found: string[] = [];
    for (const name of await readdir(os.tmpdir())) {
      if (!name.startsWith('wf-git-')) continue;
      const config = await readFile(path.join(os.tmpdir(), name, 'config'), 'utf8').catch(() => '');
      if (config.includes(url)) found.push(path.join(os.tmpdir(), name));
    }
    return found;
  }

  it('is removed after a throw from fn and after a refused tree', async () => {
    const { repo, server } = await httpFixture();
    await repo.commit([{ path: 'README.md', data: 'hello' }]);
    const auth = { kind: 'https' as const, username: '', token: '' };
    let seen: string[] = [];
    const thrown = await rejection(
      withRepo(deps(), { url: server.url, auth }, async (session) => {
        await session.fetchBranch('main');
        seen = await foldersFor(server.url);
        throw new Error('boom from fn');
      }),
    );
    expect(thrown.message).toBe('boom from fn');
    expect(seen).toHaveLength(1);
    await expect(stat(String(seen[0]))).rejects.toMatchObject({ code: 'ENOENT' });

    seen = [];
    const refused = await rejection(
      withRepo(deps(), { url: server.url, auth }, async (session) => {
        const head = await session.fetchBranch('main');
        seen = await foldersFor(server.url);
        return session.readFiles(String(head));
      }),
    );
    expect(refused).toBeInstanceOf(GitLimitError);
    expect(seen).toHaveLength(1);
    await expect(stat(String(seen[0]))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await foldersFor(server.url)).toEqual([]);
  });
});
