/**
 * P6-78 (L11): `export:credentials` and `import:credentials`. Without `--decrypted` the data stays encrypted
 * for its workspace; `--decrypted` needs `--output`, refuses stdout, writes mode 0o600 (checked on the write
 * call) and adds an audit row; an import writes through `CredentialService.create`, so the credential type
 * policy runs, encrypts under the target workspace's binding, and takes a project of `--tenant` only.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandIo } from '../src/commands/command-io';
import { exportCredentialsCommand } from '../src/commands/credentials-export';
import { importCredentialsCommand } from '../src/commands/credentials-import';
import { createTestServer, credentialIn, flushRedis, policyDeny, signup, type TestServer } from './helpers';

let server: TestServer;
let dir: string;
beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  dir = await mkdtemp(path.join(tmpdir(), 'p6-commands-cred-'));
});
afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

let ipCounter = 0;
const nextIp = () => `10.79.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface FakeIo {
  io: CommandIo;
  stdout: () => string;
  stderr: () => string;
  files: Map<string, string>;
  writes: Array<{ path: string; mode?: number }>;
}

function fakeIo(files: Record<string, string> = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const store = new Map(Object.entries(files));
  const writes: FakeIo['writes'] = [];
  return {
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      readFile: async (file) => {
        const data = store.get(file);
        if (data === undefined) throw new Error(`No such file: ${file}`);
        return data;
      },
      writeFile: async (file, data, options) => {
        store.set(file, data);
        writes.push({ path: file, mode: options.mode });
      },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    files: store,
    writes,
  };
}

async function workspace(team = false) {
  const s = await signup(server.app, { remoteAddress: nextIp(), projects: team ? 'team' : 'real' });
  const personal = await server.ctx.repos.projects.getPersonal(s.tenant.id, s.user.id);
  return {
    ...s,
    slug: s.tenant.slug,
    tenantId: s.tenant.id,
    personalId: personal!.id,
    teamId: s.client.defaultProjectId,
  };
}

const credentialsOf = (tenantId: string) => server.ctx.repos.credentials.list(tenantId);

/** one credential in the workspace's personal project with a unique secret */
async function seeded(a: Awaited<ReturnType<typeof workspace>>, name = `Key ${randomUUID().slice(0, 6)}`) {
  const secret = `sk-${randomUUID()}`;
  const row = await credentialIn(server, a.tenantId, a.personalId, { name, data: { apiKey: secret } });
  return { row, secret };
}

describe('P6-78 export:credentials', () => {
  it('keeps the data encrypted without --decrypted', async () => {
    const a = await workspace();
    const { row, secret } = await seeded(a);
    const f = fakeIo();
    expect(await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--id', row.id], f.io)).toBe(0);
    expect(f.stdout()).not.toContain(secret);
    const [entry] = JSON.parse(f.stdout());
    expect(entry).toMatchObject({ id: row.id, name: row.name, type: 'testApi' });
    expect(typeof entry.data).toBe('string');
    // --all, --id, neither
    const all = fakeIo();
    expect(await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--all'], all.io)).toBe(0);
    expect(JSON.parse(all.stdout())).toHaveLength(1);
    expect(await exportCredentialsCommand(server.ctx, ['--tenant', a.slug], fakeIo().io)).toBe(2);
    expect(
      await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--all', '--id', row.id], fakeIo().io),
    ).toBe(2);
    expect(
      await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--id', randomUUID()], fakeIo().io),
    ).toBe(1);
  });

  it('refuses --decrypted to stdout and prints no secret', async () => {
    const a = await workspace();
    const { secret } = await seeded(a);
    const f = fakeIo();
    expect(
      await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--all', '--decrypted'], f.io),
    ).not.toBe(0);
    expect(f.stdout()).toBe('');
    expect(f.stderr()).toContain('--output');
    expect(f.stderr()).not.toContain(secret);
    expect(f.writes).toHaveLength(0);
    const audit = await server.ctx.database.pool.query(
      "select 1 from audit_log where tenant_id = $1 and action = 'credentials.exported_decrypted'",
      [a.tenantId],
    );
    expect(audit.rows).toHaveLength(0);
  });

  it('writes --decrypted to a file with mode 0o600 and adds an audit row', async () => {
    const a = await workspace();
    const { row, secret } = await seeded(a);
    const f = fakeIo();
    expect(
      await exportCredentialsCommand(
        server.ctx,
        ['--tenant', a.slug, '--all', '--decrypted', '--output', '/secrets.json'],
        f.io,
      ),
    ).toBe(0);
    expect(f.writes).toEqual([{ path: '/secrets.json', mode: 0o600 }]);
    const [entry] = JSON.parse(f.files.get('/secrets.json') ?? '[]');
    expect(entry.data).toEqual({ apiKey: secret });
    expect(f.stdout()).not.toContain(secret);
    const audit = await server.ctx.database.pool.query(
      "select resource_id, metadata from audit_log where tenant_id = $1 and action = 'credentials.exported_decrypted'",
      [a.tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].resource_id).toBe(row.id);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(secret);
    // an encrypted export asks for no particular mode
    const plain = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--output', '/enc.json'],
      plain.io,
    );
    expect(plain.writes[0].mode).toBeUndefined();
  });

  it('writes one file per credential with --separate, each decrypted one mode 0o600', async () => {
    const a = await workspace();
    await seeded(a);
    await seeded(a);
    const out = path.join(dir, `sep-${randomUUID().slice(0, 8)}`);
    const f = fakeIo();
    expect(
      await exportCredentialsCommand(
        server.ctx,
        ['--tenant', a.slug, '--all', '--decrypted', '--separate', '--output', out],
        f.io,
      ),
    ).toBe(0);
    expect(f.writes).toHaveLength(2);
    expect(f.writes.every((w) => w.mode === 0o600 && w.path.startsWith(out))).toBe(true);
    expect(
      await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--all', '--separate'], fakeIo().io),
    ).toBe(2);
  });

  it("does not export another workspace's credential", async () => {
    const a = await workspace();
    const b = await workspace();
    const { row } = await seeded(b);
    const f = fakeIo();
    expect(await exportCredentialsCommand(server.ctx, ['--tenant', a.slug, '--id', row.id], f.io)).toBe(1);
    expect(f.stdout()).toBe('');
  });
});

describe('P6-78 import:credentials', () => {
  it('imports a decrypted export into another workspace and encrypts it under that workspace', async () => {
    const a = await workspace();
    const b = await workspace();
    const { row, secret } = await seeded(a, 'Shared key');
    // no log line of the commands holds the secret
    const logged: string[] = [];
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(server.ctx.logger, level).mockImplementation(((...entry: unknown[]) => {
        logged.push(JSON.stringify(entry));
      }) as never),
    );
    const exported = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--decrypted', '--output', '/c.json'],
      exported.io,
    );
    const imported = fakeIo({ '/c.json': exported.files.get('/c.json') ?? '' });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', b.slug, '--input', '/c.json'], imported.io),
    ).toBe(0);
    expect(imported.stdout() + imported.stderr()).not.toContain(secret);
    expect(imported.stdout() + imported.stderr()).not.toContain(row.id);
    const inB = await credentialsOf(b.tenantId);
    expect(inB).toHaveLength(1);
    expect(inB[0]).toMatchObject({ name: 'Shared key', type: 'testApi', projectId: b.personalId });
    expect(inB[0].id).not.toBe(row.id);
    const stored = (await server.ctx.repos.credentials.get(b.tenantId, inB[0].id))!;
    expect(server.ctx.credentials.decrypt(stored)).toEqual({ apiKey: secret });
    // bound to B: A's binding does not open it
    expect(() =>
      server.ctx.cipher.decrypt(stored.dataEnc, { tenantId: a.tenantId, credentialId: stored.id }),
    ).toThrow();
    expect(await credentialsOf(a.tenantId)).toHaveLength(1);
    for (const spy of spies) spy.mockRestore();
    expect(logged.join(' ')).not.toContain(secret);
  });

  it('puts the credential in --projectId of the workspace, and refuses another workspace project', async () => {
    const a = await workspace();
    const b = await workspace(true);
    await seeded(a);
    const exported = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--decrypted', '--output', '/p.json'],
      exported.io,
    );
    const seed = { '/p.json': exported.files.get('/p.json') ?? '' };
    const refused = fakeIo(seed);
    expect(
      await importCredentialsCommand(
        server.ctx,
        ['--tenant', b.slug, '--input', '/p.json', '--projectId', a.personalId],
        refused.io,
      ),
    ).toBe(1);
    expect(await credentialsOf(b.tenantId)).toHaveLength(0);
    const ok = fakeIo(seed);
    expect(
      await importCredentialsCommand(
        server.ctx,
        ['--tenant', b.slug, '--input', '/p.json', '--projectId', b.teamId as string],
        ok.io,
      ),
    ).toBe(0);
    expect((await credentialsOf(b.tenantId))[0].projectId).toBe(b.teamId);
  });

  it('with --projectId refuses a credential id that sits in another project of the workspace', async () => {
    const a = await workspace(true);
    const { row, secret } = await seeded(a);
    const file = JSON.stringify([{ id: row.id, name: row.name, type: 'testApi', data: { apiKey: secret } }]);
    const refused = fakeIo({ '/c.json': file });
    expect(
      await importCredentialsCommand(
        server.ctx,
        ['--tenant', a.slug, '--input', '/c.json', '--projectId', a.teamId as string],
        refused.io,
      ),
    ).toBe(1);
    expect(refused.stderr()).toContain('another project');
    expect(refused.stderr()).not.toContain(secret);
    expect(await credentialsOf(a.tenantId)).toHaveLength(1);
    // without --projectId the personal project is the target and the same file imports
    const ok = fakeIo({ '/c.json': file });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', a.slug, '--input', '/c.json'], ok.io),
    ).toBe(0);
  });

  it('refuses a blocked credential type with its violation and a non-zero exit', async () => {
    const a = await workspace();
    const b = await workspace();
    await seeded(a);
    await policyDeny(server, b.tenantId, 'credential', 'testApi');
    const exported = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--decrypted', '--output', '/d.json'],
      exported.io,
    );
    const f = fakeIo({ '/d.json': exported.files.get('/d.json') ?? '' });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', b.slug, '--input', '/d.json'], f.io),
    ).not.toBe(0);
    expect(f.stderr()).toContain('testApi');
    expect(f.stderr()).toContain('blocked');
    expect(await credentialsOf(b.tenantId)).toHaveLength(0);
  });

  it('restores an encrypted export in its own workspace and refuses it in another', async () => {
    const a = await workspace();
    const b = await workspace();
    const { secret } = await seeded(a, 'Round trip');
    const exported = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.slug, '--all', '--output', '/r.json'],
      exported.io,
    );
    const seed = { '/r.json': exported.files.get('/r.json') ?? '' };
    const own = fakeIo(seed);
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', a.slug, '--input', '/r.json'], own.io),
    ).toBe(0);
    const inA = await credentialsOf(a.tenantId);
    expect(inA).toHaveLength(2);
    for (const c of inA) {
      expect(
        server.ctx.credentials.decrypt((await server.ctx.repos.credentials.get(a.tenantId, c.id))!),
      ).toEqual({
        apiKey: secret,
      });
    }
    const other = fakeIo(seed);
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', b.slug, '--input', '/r.json'], other.io),
    ).toBe(1);
    expect(other.stderr()).toContain('--decrypted');
    expect(await credentialsOf(b.tenantId)).toHaveLength(0);
  });

  it('refuses an unknown type, a file that is not a credential list, and a missing --input', async () => {
    const a = await workspace();
    const unknown = fakeIo({
      '/u.json': JSON.stringify([{ name: 'X', type: `nope${randomUUID().slice(0, 4)}`, data: { a: 1 } }]),
    });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', a.slug, '--input', '/u.json'], unknown.io),
    ).toBe(1);
    const junk = fakeIo({ '/j.json': '{"not":"a list"}' });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', a.slug, '--input', '/j.json'], junk.io),
    ).toBe(1);
    expect(await importCredentialsCommand(server.ctx, ['--tenant', a.slug], fakeIo().io)).toBe(2);
    expect(await credentialsOf(a.tenantId)).toHaveLength(0);
  });
});
