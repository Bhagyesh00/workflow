/**
 * P6-72 (S4 L1): what `withRepo` reads from and writes to a tree. `readFiles` refuses a symlink (120000), a
 * submodule (160000), a `..` entry, an absolute path and any path outside `SOURCE_CONTROL_PATHS`, and enforces the
 * limits (5 MiB per file, 300 MiB in all, 5000 files; smaller numbers here through `GitDeps.limits`).
 * `writeCommit` writes only work folder paths, as valid Git trees (`git fsck --strict` on the pushed repository).
 * The remote is the plain HTTP fake on 127.0.0.1 (no token).
 */
import { HttpClient } from '@workflow/core';
import { SOURCE_CONTROL_LIMITS } from '@workflow/workflow';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type GitDeps,
  GitLimitError,
  GitRemoteError,
  type GitSession,
  withRepo,
} from '../src/services/source-control/git-repo';
import {
  type BareRepo,
  createBareRepo,
  type GitHttpServer,
  requireGit,
  startGitHttpServer,
  type TreeFile,
} from './fakes/git-server';

const ID1 = '0b7c2f1e-4a55-4c1e-9d3e-2f1a7b6c5d4e';
const ID2 = '7d1e2f3a-9b8c-4d5e-8f6a-1b2c3d4e5f60';
const ID3 = 'c3b2a190-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const AUTHOR = { name: 'Workflow', email: 'workflow@example.test' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

beforeAll(async () => {
  expect(await requireGit()).toMatch(/^git version/);
});

async function fixture(): Promise<{ repo: BareRepo; server: GitHttpServer }> {
  const repo = await createBareRepo();
  const server = await startGitHttpServer(repo);
  cleanups.push(
    () => repo.cleanup(),
    () => server.close(),
  );
  return { repo, server };
}

function deps(limits: Partial<Record<keyof typeof SOURCE_CONTROL_LIMITS, number>> = {}): GitDeps {
  return {
    http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }),
    limits: { ...SOURCE_CONTROL_LIMITS, ...limits } as GitDeps['limits'],
  };
}

/** seeds `files` on main and runs `fn` with a session on the repository */
async function onTree<T>(
  files: TreeFile[],
  fn: (session: GitSession, head: string) => Promise<T>,
  limits: Partial<Record<keyof typeof SOURCE_CONTROL_LIMITS, number>> = {},
): Promise<T> {
  const { repo, server } = await fixture();
  await repo.commit(files);
  return withRepo(
    deps(limits),
    { url: server.url, auth: { kind: 'https', username: '', token: '' } },
    async (s) => {
      const head = await s.fetchBranch('main');
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      return fn(s, String(head));
    },
  );
}

async function readError(
  files: TreeFile[],
  limits: Partial<Record<keyof typeof SOURCE_CONTROL_LIMITS, number>> = {},
): Promise<Error> {
  try {
    await onTree(files, (s, head) => s.readFiles(head), limits);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected readFiles to refuse the tree');
}

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

describe('readFiles', () => {
  it('reads every work folder file by path', async () => {
    const files = await onTree(
      [
        { path: `workflows/${ID1}.json`, data: '{"id":1}' },
        { path: `workflows/${ID2}.json`, data: '{"id":2}' },
        { path: `credential_stubs/${ID3}.json`, data: '{"c":1}' },
        { path: `datatables/${ID3}.json`, data: '{"d":1}' },
        { path: `projects/${ID1}.json`, data: '{"p":1}' },
        { path: 'variable_stubs.json', data: '[]' },
        { path: 'tags.json', data: '{"tags":[]}' },
        { path: 'folders.json', data: '{"folders":[]}' },
      ],
      (s, head) => s.readFiles(head),
    );
    expect([...files.keys()].sort()).toEqual(
      [
        `credential_stubs/${ID3}.json`,
        `datatables/${ID3}.json`,
        'folders.json',
        `projects/${ID1}.json`,
        'tags.json',
        'variable_stubs.json',
        `workflows/${ID1}.json`,
        `workflows/${ID2}.json`,
      ].sort(),
    );
    expect(text(files.get(`workflows/${ID2}.json`))).toBe('{"id":2}');
    expect(text(files.get('tags.json'))).toBe('{"tags":[]}');
  });

  it('refuses a symlink', async () => {
    const error = await readError([
      { path: `workflows/${ID1}.json`, data: '{}' },
      { path: `workflows/${ID2}.json`, data: '/etc/passwd', mode: '120000' },
    ]);
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/symbolic link/);
  });

  it('refuses a submodule', async () => {
    const error = await readError([
      { path: `workflows/${ID1}.json`, data: '{}' },
      { path: 'vendor', data: 'a'.repeat(40), mode: '160000' },
    ]);
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/submodule/);
  });

  it('refuses a ../ entry', async () => {
    const error = await readError([
      { path: `workflows/${ID1}.json`, data: '{}' },
      { path: `../workflows/${ID2}.json`, data: '{}' },
    ]);
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/leaves the work folder/);
  });

  it('never reads an entry with an empty name (the tree form of an absolute path)', async () => {
    // git's upload-pack does not send the objects under an empty name, so the walk fails closed either way
    const error = await readError([{ path: `/workflows/${ID1}.json`, data: '{}' }]);
    expect(error instanceof GitLimitError || error instanceof GitRemoteError).toBe(true);
  });

  it('refuses an unknown path', async () => {
    for (const unknown of [
      'README.md',
      `workflows/${ID1}.yaml`,
      `workflows/nested/${ID1}.json`,
      'workflows/NOT-A-UUID.json',
    ]) {
      const error = await readError([
        { path: `workflows/${ID2}.json`, data: '{}' },
        { path: unknown, data: 'x' },
      ]);
      expect(error, unknown).toBeInstanceOf(GitLimitError);
      expect(error.message).toMatch(/does not use/);
    }
  });

  it('refuses an oversized blob', async () => {
    const error = await readError(
      [
        { path: `workflows/${ID1}.json`, data: 'x'.repeat(64) },
        { path: `workflows/${ID2}.json`, data: 'y'.repeat(65) },
      ],
      { fileBytes: 64 },
    );
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/larger than 64 bytes/);
  });

  it('refuses too many files', async () => {
    const error = await readError(
      [
        { path: `workflows/${ID1}.json`, data: '{}' },
        { path: `workflows/${ID2}.json`, data: '{}' },
        { path: `workflows/${ID3}.json`, data: '{}' },
      ],
      { files: 2 },
    );
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/more than 2 files/);
  });

  it('refuses a tree over the total size', async () => {
    const error = await readError(
      [
        { path: `workflows/${ID1}.json`, data: 'a'.repeat(60) },
        { path: `workflows/${ID2}.json`, data: 'b'.repeat(60) },
      ],
      { totalBytes: 100 },
    );
    expect(error).toBeInstanceOf(GitLimitError);
    expect(error.message).toMatch(/100 bytes in all/);
  });

  it('refuses a commit id that is not one', async () => {
    const error = await onTree([{ path: 'tags.json', data: '[]' }], (s) => s.readFiles('../../etc')).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GitRemoteError);
  });
});

describe('writeCommit', () => {
  it('writes nested trees git accepts and reads them back', async () => {
    const { repo, server } = await fixture();
    const seed = await repo.commit([{ path: 'tags.json', data: '[]' }]);
    const commit = await withRepo(
      deps(),
      { url: server.url, auth: { kind: 'https', username: '', token: '' } },
      async (s) => {
        const head = await s.fetchBranch('main');
        const files = new Map<string, Uint8Array>([
          [`workflows/${ID2}.json`, new TextEncoder().encode('{"b":2}')],
          [`workflows/${ID1}.json`, new TextEncoder().encode('{"a":1}')],
          ['tags.json', new TextEncoder().encode('[1]')],
          [`credential_stubs/${ID3}.json`, new TextEncoder().encode('{}')],
          ['folders.json', new TextEncoder().encode('[]')],
        ]);
        const id = await s.writeCommit({
          parent: head,
          files,
          message: 'Updated Workfolder',
          author: AUTHOR,
        });
        // the store reads back exactly what was written
        const back = await s.readFiles(id);
        expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
        await s.push('main', id, { force: false });
        return id;
      },
    );
    await repo.fsck();
    expect(await repo.head()).toBe(commit);
    expect(await repo.parents(commit)).toEqual([seed]);
    expect(await repo.message(commit)).toBe('Updated Workfolder');
    expect(Object.fromEntries(await repo.files(commit))).toEqual({
      [`workflows/${ID1}.json`]: '{"a":1}',
      [`workflows/${ID2}.json`]: '{"b":2}',
      'tags.json': '[1]',
      [`credential_stubs/${ID3}.json`]: '{}',
      'folders.json': '[]',
    });
  });

  it('refuses a path outside the work folder rules, and a file over the limit', async () => {
    for (const bad of ['../evil.json', '/abs.json', 'README.md', `workflows/${ID1}.json/x`, '.git/config']) {
      const error = await onTree([{ path: 'tags.json', data: '[]' }], (s, head) =>
        s.writeCommit({
          parent: head,
          files: new Map([[bad, new Uint8Array(1)]]),
          message: 'm',
          author: AUTHOR,
        }),
      ).catch((e) => e);
      expect(error, bad).toBeInstanceOf(GitLimitError);
    }
    const big = await onTree(
      [{ path: 'tags.json', data: '[]' }],
      (s, head) =>
        s.writeCommit({
          parent: head,
          files: new Map([[`workflows/${ID1}.json`, new Uint8Array(65)]]),
          message: 'm',
          author: AUTHOR,
        }),
      { fileBytes: 64 },
    ).catch((e) => e);
    expect(big).toBeInstanceOf(GitLimitError);
  });

  it('a non fast-forward push is refused without force and passes with force', async () => {
    const { repo, server } = await fixture();
    await repo.commit([{ path: 'tags.json', data: '[]' }]);
    const remote = { url: server.url, auth: { kind: 'https' as const, username: '', token: '' } };
    const result = await withRepo(deps(), remote, async (s) => {
      const head = await s.fetchBranch('main');
      // the remote moves on after the fetch
      const moved = await repo.commit([{ path: 'tags.json', data: '[2]' }]);
      const mine = await s.writeCommit({
        parent: head,
        files: new Map([['tags.json', new TextEncoder().encode('[3]')]]),
        message: 'mine',
        author: AUTHOR,
      });
      const refused = await s.push('main', mine, { force: false }).catch((e) => e);
      expect(await repo.head()).toBe(moved);
      await s.push('main', mine, { force: true });
      return { refused, mine };
    });
    expect(result.refused).toBeInstanceOf(GitRemoteError);
    expect(await repo.head()).toBe(result.mine);
  });

  it('refuses a bad branch name', async () => {
    for (const branch of ['-x', 'a..b', 'a b', 'x.lock', 'a:b', '']) {
      const error = await onTree([{ path: 'tags.json', data: '[]' }], (s) => s.fetchBranch(branch)).catch(
        (e) => e,
      );
      expect(error, branch).toBeInstanceOf(GitRemoteError);
    }
  });
});
