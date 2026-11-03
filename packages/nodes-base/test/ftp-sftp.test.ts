import dns from 'node:dns';
import net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Item } from '@workflow/workflow';
import { Client as FtpClient } from 'basic-ftp';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFtpClient, parseFtpListDate } from '../src/utils/file-transfer';
import { type FtpServer, startFtpServer } from './ftp-server';
import { runNode } from './harness';
import { localHttp } from './servers';
import { addDir, addFile, type SshServer, startSshServer } from './ssh-server';

const FTP_PASSWORD = 'ftp-pw';
const SFTP_PASSWORD = 'sftp-pw';
const REBIND = 'rebind.test';
const PUBLIC = '93.184.215.14';
const keyPair = ssh2.utils.generateKeyPairSync('ed25519');

let ftp: FtpServer;
let pasvElsewhere: FtpServer;
let sftp: SshServer;
const http = localHttp();

beforeAll(async () => {
  ftp = await startFtpServer({ password: FTP_PASSWORD });
  pasvElsewhere = await startFtpServer({ password: FTP_PASSWORD, epsv: false, pasvHost: '10,255,255,1' });
  sftp = await startSshServer({ password: SFTP_PASSWORD, publicKey: keyPair.public });
});

afterAll(async () => {
  await Promise.all([ftp.close(), pasvElsewhere.close(), sftp.close()]);
  await http.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ftpCreds = (extra: DataObject = {}) => ({
  ftp: { host: '127.0.0.1', port: ftp.port, username: 'tester', password: FTP_PASSWORD, ...extra },
});
const sftpCreds = (extra: DataObject = {}) => ({
  sftp: { host: '127.0.0.1', port: sftp.port, username: 'tester', password: SFTP_PASSWORD, ...extra },
});

function run(
  protocol: 'ftp' | 'sftp',
  parameters: DataObject,
  input: Item[] = [{ json: {} }],
  options: {
    creds?: Record<string, DataObject>;
    http?: HttpClient;
    limit?: number;
    continueOnFail?: boolean;
  } = {},
) {
  return runNode('core.ftp', { protocol, ...parameters }, input, {
    creds: options.creds ?? (protocol === 'ftp' ? ftpCreds() : sftpCreds()),
    services: {
      http: options.http ?? http,
      ...(options.limit ? { nodeLimits: { maxRemoteFileBytes: options.limit } } : {}),
    },
    node: options.continueOnFail ? { onError: 'continueRegularOutput' } : {},
  });
}

const text = (s: string, fileName = 'note.txt') => ({
  data: Buffer.from(s).toString('base64'),
  mimeType: 'text/plain',
  fileName,
});

const content = (files: Map<string, { type: string; data?: Buffer }>, p: string) => {
  const entry = files.get(p);
  return entry?.type === 'file' ? entry.data?.toString() : undefined;
};

/** a fresh tree before each test: /docs/a.txt, /docs/sub/b.txt */
function seed(files: FtpServer['files']) {
  for (const key of [...files.keys()]) if (key !== '/' && !key.startsWith('/home')) files.delete(key);
  addDir(files, '/docs');
  addFile(files, '/docs/a.txt', 'alpha');
  addDir(files, '/docs/sub');
  addFile(files, '/docs/sub/b.txt', 'bravo!');
}

beforeEach(() => {
  seed(ftp.files);
  seed(sftp.files);
});

describe('FTP', () => {
  it('lists a folder in n8n shape with ISO dates', async () => {
    const r = await run('ftp', { operation: 'list', path: '/docs' });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([
      {
        type: '-',
        name: 'a.txt',
        size: 5,
        modifyTime: '2024-01-02T00:00:00.000Z',
        rights: { user: 'rw', group: 'r', other: 'r' },
        owner: 'owner',
        group: 'group',
        path: '/docs/a.txt',
      },
      {
        type: 'd',
        name: 'sub',
        size: 4096,
        modifyTime: '2024-01-02T00:00:00.000Z',
        rights: { user: 'rwx', group: 'rx', other: 'rx' },
        owner: 'owner',
        group: 'group',
        path: '/docs/sub',
      },
    ]);
  });

  it('lists recursively as n8n: folders included, level by level, with full paths', async () => {
    addDir(ftp.files, '/docs/sub/deeper');
    addFile(ftp.files, '/docs/z.txt', 'zulu');
    const r = await run('ftp', { operation: 'list', path: '/docs', recursive: true });
    expect(r.outputs[0].map((e) => e.path)).toEqual([
      '/docs/a.txt',
      '/docs/sub',
      '/docs/z.txt',
      '/docs/sub/b.txt',
      '/docs/sub/deeper',
    ]);
    expect(r.outputs[0].find((e) => e.path === '/docs/sub')?.type).toBe('d');
  });

  it('stops a recursive list that loops (a folder that lists itself) with a clear error', async () => {
    const looping = await startFtpServer({
      password: FTP_PASSWORD,
      extraListing: (dir) =>
        dir.startsWith('/loop') ? ['drwxr-xr-x 1 owner group 4096 Jan 02 2024 loop'] : [],
    });
    try {
      addDir(looping.files, '/loop');
      const r = await run('ftp', { operation: 'list', path: '/loop', recursive: true }, [{ json: {} }], {
        creds: { ftp: { host: '127.0.0.1', port: looping.port, username: 'tester', password: FTP_PASSWORD } },
      });
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/more than 50 levels deep/);
      expect(looping.commands.filter((c) => c.startsWith('LIST')).length).toBeLessThanOrEqual(52);
    } finally {
      await looping.close();
    }
  });

  it('downloads a file into a binary field and keeps the item json', async () => {
    const r = await run(
      'ftp',
      { operation: 'download', path: '/docs/sub/b.txt', binaryPropertyName: 'file' },
      [{ json: { keep: 1 } }],
    );
    expect(r.status).toBe('success');
    const item = r.items[0][0];
    expect(item.json).toEqual({ keep: 1 });
    expect(item.binary?.file?.fileName).toBe('b.txt');
    expect(Buffer.from(item.binary!.file!.data, 'base64').toString()).toBe('bravo!');
  });

  it('uploads a binary field and returns the input item', async () => {
    const input = [{ json: { n: 1 }, binary: { data: text('uploaded') } }] as Item[];
    const r = await run(
      'ftp',
      { operation: 'upload', path: '/docs/up.txt', binaryPropertyName: 'data' },
      input,
    );
    expect(r.status).toBe('success');
    expect(content(ftp.files, '/docs/up.txt')).toBe('uploaded');
    expect(r.items[0][0].json).toEqual({ n: 1 });
    expect(r.items[0][0].binary?.data?.fileName).toBe('note.txt');
  });

  it('uploads text content and creates missing folders after a 553 reply', async () => {
    const r = await run('ftp', {
      operation: 'upload',
      path: '/new/deep/file.txt',
      binaryData: false,
      fileContent: 'from text',
    });
    expect(r.status).toBe('success');
    expect(content(ftp.files, '/new/deep/file.txt')).toBe('from text');
    expect(ftp.commands.filter((c) => c.startsWith('STOR')).slice(-2)).toEqual([
      'STOR /new/deep/file.txt',
      'STOR /new/deep/file.txt',
    ]);
  });

  it('renames, and creates the target folder on 550 only with Create Directories', async () => {
    const plain = await run('ftp', { operation: 'rename', oldPath: '/docs/a.txt', newPath: '/docs/c.txt' });
    expect(plain.outputs[0]).toEqual([{ success: true }]);
    expect(content(ftp.files, '/docs/c.txt')).toBe('alpha');

    const refused = await run('ftp', {
      operation: 'rename',
      oldPath: '/docs/c.txt',
      newPath: '/moved/c.txt',
    });
    expect(refused.status).toBe('error');

    const created = await run('ftp', {
      operation: 'rename',
      oldPath: '/docs/c.txt',
      newPath: '/moved/c.txt',
      options: { createDirectories: true },
    });
    expect(created.outputs[0]).toEqual([{ success: true }]);
    expect(content(ftp.files, '/moved/c.txt')).toBe('alpha');
  });

  it('deletes a file, an empty folder and a folder recursively', async () => {
    expect((await run('ftp', { operation: 'delete', path: '/docs/a.txt' })).outputs[0]).toEqual([
      { success: true },
    ]);
    expect(ftp.files.has('/docs/a.txt')).toBe(false);

    const notEmpty = await run('ftp', { operation: 'delete', path: '/docs', options: { folder: true } });
    expect(notEmpty.status).toBe('error');

    const recursive = await run('ftp', {
      operation: 'delete',
      path: '/docs',
      options: { folder: true, recursive: true },
    });
    expect(recursive.outputs[0]).toEqual([{ success: true }]);
    expect([...ftp.files.keys()].filter((k) => k.startsWith('/docs'))).toEqual([]);
  });

  it('refuses a download above the instance remote file limit', async () => {
    addFile(ftp.files, '/docs/big.bin', Buffer.alloc(3000, 7));
    const r = await run(
      'ftp',
      { operation: 'download', path: '/docs/big.bin', binaryPropertyName: 'data' },
      [{ json: {} }],
      {
        limit: 1000,
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/larger than the limit/);
  });

  it('a download over the cap mid-transfer (no SIZE) fails that item only: the next item still downloads', async () => {
    const noSize = await startFtpServer({ password: FTP_PASSWORD, size: false });
    try {
      addDir(noSize.files, '/docs');
      addFile(noSize.files, '/docs/big.bin', Buffer.alloc(300_000, 7));
      addFile(noSize.files, '/docs/a.txt', 'alpha');
      const r = await run(
        'ftp',
        { operation: 'download', path: '={{ $json.p }}', binaryPropertyName: 'data' },
        [{ json: { p: '/docs/big.bin' } }, { json: { p: '/docs/a.txt' } }],
        {
          limit: 1000,
          continueOnFail: true,
          creds: {
            ftp: { host: '127.0.0.1', port: noSize.port, username: 'tester', password: FTP_PASSWORD },
          },
        },
      );
      expect(r.status).toBe('success');
      expect(String(r.outputs[0][0].error)).toMatch(/larger than the limit/);
      expect(r.outputs[0][1]).toEqual({ p: '/docs/a.txt' });
      expect(Buffer.from(String(r.items[0][1].binary?.data?.data), 'base64').toString()).toBe('alpha');
    } finally {
      await noSize.close();
    }
  });

  it('the Timeout option bounds sign-in only: a slow reply afterwards still succeeds', async () => {
    const slow = await startFtpServer({ password: FTP_PASSWORD, delay: { verb: 'LIST', ms: 1500 } });
    try {
      addDir(slow.files, '/docs');
      addFile(slow.files, '/docs/a.txt', 'alpha');
      const r = await run(
        'ftp',
        { operation: 'list', path: '/docs', options: { timeout: 500 } },
        [{ json: {} }],
        {
          creds: { ftp: { host: '127.0.0.1', port: slow.port, username: 'tester', password: FTP_PASSWORD } },
        },
      );
      expect(r.status).toBe('success');
      expect(r.outputs[0]).toHaveLength(1);
    } finally {
      await slow.close();
    }
  });

  it('refuses a path with a line break before sending any command', async () => {
    const before = ftp.commands.length;
    const r = await run('ftp', { operation: 'delete', path: '/docs/a.txt\r\nDELE /docs/sub/b.txt' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/line break/);
    expect(ftp.files.has('/docs/sub/b.txt')).toBe(true);
    expect(ftp.commands.slice(before).some((c) => c.startsWith('DELE'))).toBe(false);
  });

  it('turns a failing item into an error item and keeps the connection for the next', async () => {
    const r = await run(
      'ftp',
      { operation: 'download', path: '={{ $json.p }}', binaryPropertyName: 'data' },
      [{ json: { p: '/docs/missing.txt' } }, { json: { p: '/docs/a.txt' } }],
      { continueOnFail: true },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0][0].error).toBeTruthy();
    expect(r.outputs[0][1]).toEqual({ p: '/docs/a.txt' });
  });

  it('gives one error item per input item when sign-in fails with continue on fail', async () => {
    const r = await run('ftp', { operation: 'list', path: '/' }, [{ json: {} }, { json: {} }], {
      creds: ftpCreds({ password: 'not-the-password' }),
      continueOnFail: true,
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toHaveLength(2);
    expect(String(r.outputs[0][0].error)).toMatch(/530/);
    expect(JSON.stringify(r.outputs)).not.toContain('not-the-password');
  });

  it('parses LIST dates in both ls forms and the DOS form', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    expect(parseFtpListDate('Jan 02 2024', now)).toBe('2024-01-02T00:00:00.000Z');
    expect(parseFtpListDate('Oct 30 12:34', now)).toBe('2026-10-30T12:34:00.000Z');
    // a month after "now" belongs to last year, as ls prints it
    expect(parseFtpListDate('Dec 24 08:00', now)).toBe('2025-12-24T08:00:00.000Z');
    expect(parseFtpListDate('04-27-24 09:15PM', now)).toBe('2024-04-27T21:15:00.000Z');
    expect(parseFtpListDate('garbage', now)).toBeNull();
  });
});

describe('FTP guard', () => {
  it('never allows a separate transfer host', () => {
    const client = createFtpClient(1000);
    expect((client as unknown as { options: { allowSeparateTransferHost: boolean } }).options).toMatchObject({
      allowSeparateTransferHost: false,
    });
    client.close();
  });

  it('refuses a PASV reply that names another host, with no data connection', async () => {
    const r = await run('ftp', { operation: 'list', path: '/' }, [{ json: {} }], {
      creds: ftpCreds({ port: pasvElsewhere.port }),
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/PASV returned another host/);
    expect(pasvElsewhere.dataConnections).toBe(0);
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254'])(
    'the default client refuses %s before any connection',
    async (host) => {
      const before = ftp.connections;
      const r = await run('ftp', { operation: 'list', path: '/' }, [{ json: {} }], {
        creds: ftpCreds({ host }),
        http: new HttpClient(),
      });
      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('SSRF_BLOCKED');
      expect(ftp.connections).toBe(before);
    },
  );

  it('connects to the checked IP literal, so a name that rebinds never reaches loopback', async () => {
    const lookup = rebindDns();
    const hosts: Array<string | undefined> = [];
    vi.spyOn(FtpClient.prototype, 'access').mockImplementation(async (options) => {
      hosts.push(options?.host);
      throw new Error('stopped by the test');
    });
    const before = ftp.connections;
    const r = await run('ftp', { operation: 'list', path: '/' }, [{ json: {} }], {
      creds: ftpCreds({ host: REBIND }),
      http: new HttpClient(),
    });
    expect(r.status).toBe('error');
    expect(hosts).toEqual([PUBLIC]);
    expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
    expect(ftp.connections).toBe(before);
  });

  it('tries the next checked address when one refuses the connection', async () => {
    const DUAL = 'dual.test';
    const realPromisesLookup = dns.promises.lookup;
    vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
      host === DUAL
        ? Promise.resolve([
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ])
        : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
    const dualHttp = new HttpClient({ ssrf: { allow: [DUAL] } });
    const access = vi.spyOn(FtpClient.prototype, 'access');
    try {
      const r = await run('ftp', { operation: 'list', path: '/docs' }, [{ json: {} }], {
        creds: ftpCreds({ host: DUAL }),
        http: dualHttp,
      });
      expect(r.status).toBe('success');
      expect(r.outputs[0]).toHaveLength(2);
      expect(access.mock.calls.map(([options]) => options?.host)).toEqual(['::1', '127.0.0.1']);
    } finally {
      await dualHttp.close();
    }
  });
});

describe('SFTP', () => {
  it('lists a folder in n8n shape with ISO dates', async () => {
    const r = await run('sftp', { operation: 'list', path: '/docs' });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([
      {
        type: '-',
        name: 'a.txt',
        size: 5,
        modifyTime: '2024-01-02T03:04:05.000Z',
        accessTime: '2024-01-02T03:04:05.000Z',
        rights: { user: 'rw', group: 'r', other: 'r' },
        owner: 1000,
        group: 1000,
        path: '/docs/a.txt',
      },
      {
        type: 'd',
        name: 'sub',
        size: 4096,
        modifyTime: '2024-01-02T03:04:05.000Z',
        accessTime: '2024-01-02T03:04:05.000Z',
        rights: { user: 'rwx', group: 'rx', other: 'rx' },
        owner: 1000,
        group: 1000,
        path: '/docs/sub',
      },
    ]);
  });

  it('lists recursively as n8n: folders included, level by level, with full paths', async () => {
    addDir(sftp.files, '/docs/sub/deeper');
    const r = await run('sftp', { operation: 'list', path: '/docs', recursive: true });
    expect(r.outputs[0].map((e) => e.path)).toEqual([
      '/docs/a.txt',
      '/docs/sub',
      '/docs/sub/b.txt',
      '/docs/sub/deeper',
    ]);
  });

  it('downloads a file into a binary field and keeps the item json', async () => {
    const r = await run('sftp', { operation: 'download', path: '/docs/a.txt', binaryPropertyName: 'data' }, [
      { json: { keep: 2 } },
    ]);
    const item = r.items[0][0];
    expect(item.json).toEqual({ keep: 2 });
    expect(item.binary?.data?.fileName).toBe('a.txt');
    expect(Buffer.from(item.binary!.data!.data, 'base64').toString()).toBe('alpha');
  });

  it('uploads into folders it creates, from a binary field or text', async () => {
    const input = [{ json: { n: 1 }, binary: { data: text('sftp upload') } }] as Item[];
    const r = await run(
      'sftp',
      { operation: 'upload', path: '/x/y/up.txt', binaryPropertyName: 'data' },
      input,
    );
    expect(r.status).toBe('success');
    expect(r.items[0][0].json).toEqual({ n: 1 });
    expect(content(sftp.files, '/x/y/up.txt')).toBe('sftp upload');

    await run('sftp', { operation: 'upload', path: '/docs/t.txt', binaryData: false, fileContent: 'plain' });
    expect(content(sftp.files, '/docs/t.txt')).toBe('plain');
  });

  it('renames, creating the target folder only with Create Directories', async () => {
    const refused = await run('sftp', {
      operation: 'rename',
      oldPath: '/docs/a.txt',
      newPath: '/moved/a.txt',
    });
    expect(refused.status).toBe('error');
    const r = await run('sftp', {
      operation: 'rename',
      oldPath: '/docs/a.txt',
      newPath: '/moved/a.txt',
      options: { createDirectories: true },
    });
    expect(r.outputs[0]).toEqual([{ success: true }]);
    expect(content(sftp.files, '/moved/a.txt')).toBe('alpha');
  });

  it('deletes a file and a folder recursively', async () => {
    expect((await run('sftp', { operation: 'delete', path: '/docs/a.txt' })).outputs[0]).toEqual([
      { success: true },
    ]);
    const notEmpty = await run('sftp', { operation: 'delete', path: '/docs', options: { folder: true } });
    expect(notEmpty.status).toBe('error');
    const r = await run('sftp', {
      operation: 'delete',
      path: '/docs',
      options: { folder: true, recursive: true },
    });
    expect(r.outputs[0]).toEqual([{ success: true }]);
    expect([...sftp.files.keys()].filter((k) => k.startsWith('/docs'))).toEqual([]);
  });

  it('refuses a download above the instance remote file limit', async () => {
    addFile(sftp.files, '/docs/big.bin', Buffer.alloc(3000, 7));
    const r = await run(
      'sftp',
      { operation: 'download', path: '/docs/big.bin', binaryPropertyName: 'data' },
      [{ json: {} }],
      {
        limit: 1000,
      },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/larger than the limit/);
  });

  it('signs in with a private key pasted on one line', async () => {
    const r = await run('sftp', { operation: 'list', path: '/docs' }, [{ json: {} }], {
      creds: sftpCreds({ password: '', privateKey: keyPair.private.replace(/\n/g, ' ') }),
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toHaveLength(2);
  });

  it('sends the password with the key: a refused key falls back to the password', async () => {
    const other = ssh2.utils.generateKeyPairSync('ed25519');
    const r = await run('sftp', { operation: 'list', path: '/docs' }, [{ json: {} }], {
      creds: sftpCreds({ privateKey: other.private }),
    });
    expect(r.status).toBe('success');
  });

  it('signs in to a server that requires the key and the password', async () => {
    const strict = await startSshServer({
      password: SFTP_PASSWORD,
      publicKey: keyPair.public,
      requireKeyAndPassword: true,
    });
    try {
      addDir(strict.files, '/docs');
      const creds = (password: string) => ({
        sftp: {
          host: '127.0.0.1',
          port: strict.port,
          username: 'tester',
          password,
          privateKey: keyPair.private,
        },
      });
      const ok = await run('sftp', { operation: 'list', path: '/docs' }, [{ json: {} }], {
        creds: creds(SFTP_PASSWORD),
      });
      expect(ok.status).toBe('success');
      const keyOnly = await run('sftp', { operation: 'list', path: '/docs' }, [{ json: {} }], {
        creds: creds(''),
      });
      expect(keyOnly.status).toBe('error');
    } finally {
      await strict.close();
    }
  });

  it('refuses a path with a line break', async () => {
    const r = await run('sftp', { operation: 'delete', path: '/docs/a.txt\nx' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/line break/);
  });
});

describe('SFTP guard', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254'])(
    'the default client refuses %s before any connection',
    async (host) => {
      const before = sftp.connections;
      const r = await run('sftp', { operation: 'list', path: '/' }, [{ json: {} }], {
        creds: sftpCreds({ host }),
        http: new HttpClient(),
      });
      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('SSRF_BLOCKED');
      expect(sftp.connections).toBe(before);
    },
  );

  it('connects to the checked address when the name rebinds to loopback afterwards', async () => {
    const lookup = rebindDns();
    const targets: string[] = [];
    const realConnect = net.connect;
    vi.spyOn(net, 'connect').mockImplementation(((...args: unknown[]) => {
      const socket = (realConnect as (...a: unknown[]) => net.Socket)(...args);
      socket.once('lookup', (_error: Error | null, address: string) => {
        targets.push(address);
        socket.destroy(new Error('stopped by the test'));
      });
      return socket;
    }) as never);
    const before = sftp.connections;
    const r = await run('sftp', { operation: 'list', path: '/' }, [{ json: {} }], {
      creds: sftpCreds({ host: REBIND }),
      http: new HttpClient(),
    });
    expect(r.status).toBe('error');
    expect(targets).toEqual([PUBLIC]);
    expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
    expect(sftp.connections).toBe(before);
  });
});

/**
 * A rebinding name: the SSRF check (dns.promises.lookup) sees a public address, while anything that
 * resolves the name again at connect time (dns.lookup) gets loopback.
 */
function rebindDns() {
  const realLookup = dns.lookup;
  const realPromisesLookup = dns.promises.lookup;
  vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
    host === REBIND
      ? Promise.resolve([{ address: PUBLIC, family: 4 }])
      : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
  return vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
    if (host !== REBIND) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
    const callback = rest[rest.length - 1] as (...args: unknown[]) => void;
    callback(null, '127.0.0.1', 4);
  }) as never);
}
