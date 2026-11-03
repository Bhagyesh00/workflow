import dns from 'node:dns';
import net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Item } from '@workflow/workflow';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runNode } from './harness';
import { localHttp } from './servers';
import { addFile, type ExecResult, type SshServer, startSshServer } from './ssh-server';

const PASSWORD = 'pw-for-tests';
const keyPair = ssh2.utils.generateKeyPairSync('ed25519');
const lockedPair = ssh2.utils.generateKeyPairSync('ed25519', {
  passphrase: 'open sesame',
  cipher: 'aes256-ctr',
  rounds: 16,
});

let execAnswer: (command: string) => ExecResult = () => ({ code: 0 });
let server: SshServer;
let keyServer: SshServer;
let lockedServer: SshServer;
const http = localHttp();

beforeAll(async () => {
  server = await startSshServer({ password: PASSWORD, exec: (command) => execAnswer(command) });
  keyServer = await startSshServer({ publicKey: keyPair.public, exec: () => ({ stdout: 'key ok\n' }) });
  lockedServer = await startSshServer({
    publicKey: lockedPair.public,
    exec: () => ({ stdout: 'locked ok' }),
  });
});

afterAll(async () => {
  await Promise.all([server.close(), keyServer.close(), lockedServer.close()]);
  await http.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  execAnswer = () => ({ code: 0 });
});

const passwordCreds = (extra: DataObject = {}) => ({
  sshPassword: { host: '127.0.0.1', port: server.port, username: 'tester', password: PASSWORD, ...extra },
});

function run(
  parameters: DataObject,
  input: Item[] = [{ json: {} }],
  options: {
    creds?: Record<string, DataObject>;
    http?: HttpClient;
    limit?: number;
    continueOnFail?: boolean;
  } = {},
) {
  return runNode('core.ssh', parameters, input, {
    creds: options.creds ?? passwordCreds(),
    services: {
      http: options.http ?? http,
      ...(options.limit ? { nodeLimits: { maxRemoteFileBytes: options.limit } } : {}),
    },
    node: options.continueOnFail ? { onError: 'continueRegularOutput' } : {},
  });
}

const execute = (command: string, cwd = '/') => ({ resource: 'command', operation: 'execute', command, cwd });

describe('SSH node: execute', () => {
  it('runs the command in the working folder and returns code, signal, stdout and stderr', async () => {
    execAnswer = () => ({ stdout: 'hello\n', stderr: 'careful\n', code: 0 });
    const r = await run(execute('echo hello', '/tmp'));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ code: 0, signal: null, stdout: 'hello', stderr: 'careful' }]);
    expect(server.commands.at(-1)).toBe(`cd '/tmp' ; echo hello`);
    expect(r.items[0][0].pairedItem).toEqual({ item: 0 });
  });

  it('keeps a non-zero exit code and a signal as output, not as an error', async () => {
    execAnswer = (command) => (command.endsWith('false') ? { code: 2, stderr: 'boom' } : { signal: 'TERM' });
    const r = await run(execute('false'), [{ json: {} }]);
    expect(r.outputs[0]).toEqual([{ code: 2, signal: null, stdout: '', stderr: 'boom' }]);
    const killed = await run(execute('sleep 100'));
    expect(killed.outputs[0]).toEqual([{ code: null, signal: 'SIGTERM', stdout: '', stderr: '' }]);
  });

  it('quotes the working folder so it cannot run its own commands', async () => {
    await run(execute('ls', "/data/it's; rm -rf /"));
    expect(server.commands.at(-1)).toBe(`cd '/data/it'\\''s; rm -rf /' ; ls`);
  });

  it('runs one command per input item over one connection', async () => {
    const before = server.connections;
    execAnswer = (command) => ({ stdout: command.split(' ; ')[1] });
    const r = await run({ ...execute('={{ "echo " + $json.n }}') }, [{ json: { n: 1 } }, { json: { n: 2 } }]);
    expect(r.outputs[0].map((o) => o.stdout)).toEqual(['echo 1', 'echo 2']);
    expect(server.connections - before).toBe(1);
  });

  it('expands ~/ in the working folder from the remote $HOME and refuses a bare ~', async () => {
    await run(execute('pwd', '~/work'));
    expect(server.commands.at(-1)).toBe(`cd '/home/tester/work' ; pwd`);
    const bare = await run(execute('pwd', '~'));
    expect(bare.status).toBe('error');
    expect(bare.error?.message).toMatch(/Invalid path\. Replace "~" with home directory or "~\/"/);
  });

  it('fails with a wrong password and never shows the password', async () => {
    const r = await run(execute('ls'), [{ json: {} }], {
      creds: passwordCreds({ password: 'wrong-secret' }),
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/authentication/i);
    expect(JSON.stringify(r.error)).not.toContain('wrong-secret');
  });

  it('caps command output at the instance remote file limit', async () => {
    execAnswer = () => ({ stdout: 'x'.repeat(5000) });
    const r = await run(execute('yes'), [{ json: {} }], { limit: 1000 });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/output is larger than/i);
  });
});

describe('SSH node: private key', () => {
  it('signs in with a key pasted on one line', async () => {
    const oneLine = keyPair.private.replace(/\n/g, ' ');
    const r = await run({ authentication: 'privateKey', ...execute('id') }, [{ json: {} }], {
      creds: {
        sshPrivateKey: { host: '127.0.0.1', port: keyServer.port, username: 'tester', privateKey: oneLine },
      },
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0][0]).toMatchObject({ code: 0, stdout: 'key ok' });
  });

  it('signs in with a key locked by a passphrase', async () => {
    const r = await run({ authentication: 'privateKey', ...execute('id') }, [{ json: {} }], {
      creds: {
        sshPrivateKey: {
          host: '127.0.0.1',
          port: lockedServer.port,
          username: 'tester',
          privateKey: lockedPair.private,
          passphrase: 'open sesame',
        },
      },
    });
    expect(r.status).toBe('success');
    expect(r.outputs[0][0]).toMatchObject({ stdout: 'locked ok' });
  });
});

describe('SSH node: files', () => {
  const text = (s: string) => ({
    data: Buffer.from(s).toString('base64'),
    mimeType: 'text/plain',
    fileName: 'note.txt',
  });

  it('uploads a binary field into a folder and downloads it back', async () => {
    const up = await run(
      { resource: 'file', operation: 'upload', path: '/home/tester', binaryPropertyName: 'data' },
      [{ json: { n: 1 }, binary: { data: text('hello over sftp') } }] as Item[],
    );
    expect(up.status).toBe('success');
    expect(up.outputs[0]).toEqual([{ success: true }]);
    const stored = server.files.get('/home/tester/note.txt');
    expect(stored?.type === 'file' && stored.data.toString()).toBe('hello over sftp');

    const down = await run(
      { resource: 'file', operation: 'download', path: '/home/tester/note.txt', binaryPropertyName: 'file' },
      [{ json: { keep: true } }],
    );
    expect(down.status).toBe('success');
    const item = down.items[0][0];
    expect(item.json).toEqual({ keep: true });
    expect(item.binary?.file?.fileName).toBe('note.txt');
    expect(Buffer.from(item.binary!.file!.data, 'base64').toString()).toBe('hello over sftp');
  });

  it('uses the File Name option on upload (path parts removed) and on download', async () => {
    await run(
      {
        resource: 'file',
        operation: 'upload',
        path: '~/',
        binaryPropertyName: 'data',
        options: { fileName: '../renamed.txt' },
      },
      [{ json: {}, binary: { data: text('renamed') } }] as Item[],
    );
    const stored = server.files.get('/home/tester/renamed.txt');
    expect(stored?.type === 'file' && stored.data.toString()).toBe('renamed');

    const down = await run(
      {
        resource: 'file',
        operation: 'download',
        path: '~/renamed.txt',
        binaryPropertyName: 'data',
        options: { fileName: 'custom.bin' },
      },
      [{ json: {} }],
    );
    expect(down.items[0][0].binary?.data?.fileName).toBe('custom.bin');
  });

  it('refuses a download above the instance remote file limit', async () => {
    addFile(server.files, '/home/tester/big.bin', Buffer.alloc(4000, 1));
    const r = await run(
      { resource: 'file', operation: 'download', path: '/home/tester/big.bin', binaryPropertyName: 'data' },
      [{ json: {} }],
      { limit: 1000 },
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/larger than/i);
  });

  it('turns a failing item into an error item when continue on fail is on', async () => {
    addFile(server.files, '/home/tester/ok.txt', 'ok');
    const r = await run(
      { resource: 'file', operation: 'download', path: '={{ $json.p }}', binaryPropertyName: 'data' },
      [{ json: { p: '/home/tester/missing.txt' } }, { json: { p: '/home/tester/ok.txt' } }],
      { continueOnFail: true },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0][0].error).toBeTruthy();
    expect(r.outputs[0][1]).toEqual({ p: '/home/tester/ok.txt' });
  });
});

describe('SSH node: SSRF guard', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254'])(
    'the default client refuses %s before any connection',
    async (host) => {
      const before = server.connections;
      const r = await run(execute('id'), [{ json: {} }], {
        creds: passwordCreds({ host }),
        http: new HttpClient(),
      });
      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('SSRF_BLOCKED');
      expect(server.connections).toBe(before);
    },
  );

  it('connects to the checked address when the name rebinds to loopback afterwards', async () => {
    const REBIND = 'rebind.test';
    const PUBLIC = '93.184.215.14';
    const realLookup = dns.lookup;
    const realPromisesLookup = dns.promises.lookup;
    vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
      host === REBIND
        ? Promise.resolve([{ address: PUBLIC, family: 4 }])
        : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
      if (host !== REBIND) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
      const callback = rest[rest.length - 1] as (...args: unknown[]) => void;
      callback(null, '127.0.0.1', 4);
    }) as never);
    // stop each socket as soon as it picked its address, so the test never reaches the network
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
    const before = server.connections;
    const r = await run(execute('id'), [{ json: {} }], {
      creds: passwordCreds({ host: REBIND }),
      http: new HttpClient(),
    });
    expect(r.status).toBe('error');
    expect(targets).toEqual([PUBLIC]);
    expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
    expect(server.connections).toBe(before);
  });
});
