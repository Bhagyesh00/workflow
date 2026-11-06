import net, { type AddressInfo } from 'node:net';
import type { HttpClient } from '@workflow/core';
import type { CredentialTestContext, DataObject, NodeType } from '@workflow/workflow';
import mysql from 'mysql2';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { startFtpServer } from './ftp-server';
import { localHttp } from './servers';
import { startSshServer } from './ssh-server';

const nodeType = (name: string): NodeType => nodes.find((n) => n.description.name === name)!;

const contextFor = (http: HttpClient, signal = new AbortController().signal): CredentialTestContext => ({
  helpers: {
    resolveAllowedHost: (host) => http.resolveAllowedHost(host),
    assertHostAllowed: async () => undefined,
  },
  logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  signal,
  getTenantId: () => 't1',
});

/** run the test function that the node's credential entry names, as the server does */
function run(nodeName: string, type: string, data: DataObject, ctx = contextFor(localHttp())) {
  const node = nodeType(nodeName);
  const entry = node.description.credentials?.find((c) => c.name === type);
  return node.methods!.credentialTest![entry!.testedBy!](ctx, { type, data });
}

const OK = { status: 'OK', message: 'Connection tested successfully' };

describe('Postgres', () => {
  const base = { host: '127.0.0.1', port: 5432, database: 'nodes_test', user: 'postgres' };

  it('passes with the right password', async () => {
    expect(await run('app.postgres', 'postgres', { ...base, password: 'postgres' })).toEqual(OK);
  });

  it('fails clearly on a wrong password, with no text of the server', async () => {
    const result = await run('app.postgres', 'postgres', { ...base, password: 'wrong-pw-secret' });
    expect(result.status).toBe('Error');
    expect(result.message).toBe('Postgres refused the user name or password');
    expect(result.message).not.toContain('wrong-pw-secret');
  });

  it('fails clearly on a database that does not exist', async () => {
    const result = await run('app.postgres', 'postgres', {
      ...base,
      database: 'no_such_db_p4_22',
      password: 'postgres',
    });
    expect(result).toEqual({ status: 'Error', message: "The database doesn't exist" });
  });

  it('fails clearly on a port nothing listens on', async () => {
    const closed = await freePort();
    const result = await run('app.postgres', 'postgres', { ...base, port: closed, password: 'postgres' });
    expect(result).toEqual({
      status: 'Error',
      message: "Couldn't connect to Postgres: the connection was refused",
    });
  });

  it('refuses a host the SSRF policy blocks, before any connection', async () => {
    const { HttpClient } = await import('@workflow/core');
    const result = await run(
      'app.postgres',
      'postgres',
      { ...base, password: 'postgres' },
      contextFor(new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } })),
    );
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/not allowed|blocked|private|loopback/i);
  });

  it('fails on a credential with no host', async () => {
    expect(await run('app.postgres', 'postgres', { ...base, host: '', password: 'postgres' })).toEqual({
      status: 'Error',
      message: 'The Postgres credential has no host',
    });
  });
});

describe('MySQL', () => {
  let server: ReturnType<typeof mysql.createServer>;
  let port = 0;
  let calls = 0;

  beforeAll(async () => {
    server = mysql.createServer((conn: any) => {
      conn.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.36-fake',
        connectionId: 1,
        statusFlags: 2,
        characterSet: 8,
        capabilityFlags: 0xffffff,
        authCallback: (
          params: { user: string; database?: string },
          cb: (err: Error | null, mysqlError?: { message: string; code: number }) => void,
        ) => {
          if (params.user === 'baduser') return cb(null, { message: "Access denied for user 'SERVERTEXT'", code: 1045 });
          if (params.database === 'nodb') return cb(null, { message: "Unknown database 'SERVERTEXT'", code: 1049 });
          cb(null);
        },
      });
      conn.on('query', (sql: string) => {
        calls++;
        if (/^select 1/i.test(sql)) {
          return conn.writeTextResult([{ '1': '1' }], [
            { catalog: 'def', schema: '', table: '', orgTable: '', name: '1', orgName: '', characterSet: 63, columnLength: 1, columnType: 8, flags: 129, decimals: 0 },
          ]);
        }
        conn.writeOk();
      });
      conn.on('error', () => undefined);
    }) as never;
    await new Promise<void>((resolve) => (server as any).listen(0, '127.0.0.1', resolve));
    port = ((server as any)._server.address() as AddressInfo).port;
  });
  afterAll(() => (server as any).close());

  const creds = (extra: DataObject = {}) => ({
    host: '127.0.0.1',
    port,
    database: 'shop',
    user: 'tester',
    password: 'pw',
    ...extra,
  });

  it('passes and runs a trivial query', async () => {
    expect(await run('app.mySql', 'mySql', creds())).toEqual(OK);
    expect(calls).toBeGreaterThan(0);
  });

  it('fails clearly on a refused user, with no text of the server', async () => {
    const result = await run('app.mySql', 'mySql', creds({ user: 'baduser', password: 'wrong-pw-secret' }));
    expect(result).toEqual({ status: 'Error', message: 'MySQL refused the user name or password' });
  });

  it('fails clearly on a database that does not exist', async () => {
    expect(await run('app.mySql', 'mySql', creds({ database: 'nodb' }))).toEqual({
      status: 'Error',
      message: "The database doesn't exist",
    });
  });

  it('fails clearly on a port nothing listens on', async () => {
    const result = await run('app.mySql', 'mySql', creds({ port: await freePort() }));
    expect(result).toEqual({
      status: 'Error',
      message: "Couldn't connect to MySQL: the connection was refused",
    });
  });
});

describe('SSH', () => {
  const keyPair = ssh2.utils.generateKeyPairSync('ed25519');
  let passwordServer: Awaited<ReturnType<typeof startSshServer>>;
  let keyServer: Awaited<ReturnType<typeof startSshServer>>;

  beforeAll(async () => {
    passwordServer = await startSshServer({ username: 'tester', password: 'ssh-pw' });
    keyServer = await startSshServer({ username: 'tester', publicKey: keyPair.public });
  });
  afterAll(async () => {
    await passwordServer.close();
    await keyServer.close();
  });

  it('passes with the right password, running no command', async () => {
    const data = { host: '127.0.0.1', port: passwordServer.port, username: 'tester', password: 'ssh-pw' };
    expect(await run('core.ssh', 'sshPassword', data)).toEqual(OK);
    expect(passwordServer.commands).toEqual([]);
  });

  it('fails clearly on a wrong password', async () => {
    const data = { host: '127.0.0.1', port: passwordServer.port, username: 'tester', password: 'wrong' };
    expect(await run('core.ssh', 'sshPassword', data)).toEqual({
      status: 'Error',
      message: 'SSH refused the user name, password or key',
    });
  });

  it('passes with the right private key and fails with another one', async () => {
    const data = { host: '127.0.0.1', port: keyServer.port, username: 'tester', privateKey: keyPair.private };
    expect(await run('core.ssh', 'sshPrivateKey', data)).toEqual(OK);
    const other = ssh2.utils.generateKeyPairSync('ed25519');
    expect(await run('core.ssh', 'sshPrivateKey', { ...data, privateKey: other.private })).toEqual({
      status: 'Error',
      message: 'SSH refused the user name, password or key',
    });
  });

  it('fails clearly on a key that is not a key', async () => {
    const data = { host: '127.0.0.1', port: keyServer.port, username: 'tester', privateKey: 'nonsense' };
    const result = await run('core.ssh', 'sshPrivateKey', data);
    expect(result.status).toBe('Error');
    expect(result.message).not.toContain('nonsense');
  });

  it('fails clearly on a port nothing listens on', async () => {
    const data = { host: '127.0.0.1', port: await freePort(), username: 'tester', password: 'x' };
    const result = await run('core.ssh', 'sshPassword', data);
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/^Couldn't connect to 127\.0\.0\.1:\d+/);
  });

  it('refuses a host the SSRF policy blocks, before any connection', async () => {
    const { HttpClient } = await import('@workflow/core');
    const before = passwordServer.connections;
    const result = await run(
      'core.ssh',
      'sshPassword',
      { host: '127.0.0.1', port: passwordServer.port, username: 'tester', password: 'ssh-pw' },
      contextFor(new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } })),
    );
    expect(result.status).toBe('Error');
    expect(passwordServer.connections).toBe(before);
  });
});

describe('FTP and SFTP', () => {
  let ftp: Awaited<ReturnType<typeof startFtpServer>>;
  let sftp: Awaited<ReturnType<typeof startSshServer>>;

  beforeAll(async () => {
    ftp = await startFtpServer({ username: 'tester', password: 'ftp-pw' });
    sftp = await startSshServer({ username: 'tester', password: 'sftp-pw' });
  });
  afterAll(async () => {
    await ftp.close();
    await sftp.close();
  });

  it('FTP passes with the right password', async () => {
    const data = { host: '127.0.0.1', port: ftp.port, username: 'tester', password: 'ftp-pw' };
    expect(await run('core.ftp', 'ftp', data)).toEqual(OK);
  });

  it('FTP fails clearly on a wrong password, with no text of the server', async () => {
    const data = { host: '127.0.0.1', port: ftp.port, username: 'tester', password: 'wrong-pw-secret' };
    const result = await run('core.ftp', 'ftp', data);
    expect(result).toEqual({ status: 'Error', message: 'FTP refused the user name or password' });
  });

  it('FTP fails clearly on a port nothing listens on', async () => {
    const data = { host: '127.0.0.1', port: await freePort(), username: 'tester', password: 'x' };
    expect(await run('core.ftp', 'ftp', data)).toEqual({
      status: 'Error',
      message: "Couldn't connect over FTP: the connection was refused",
    });
  });

  it('SFTP passes with the right password and fails with a wrong one', async () => {
    const data = { host: '127.0.0.1', port: sftp.port, username: 'tester', password: 'sftp-pw' };
    expect(await run('core.ftp', 'sftp', data)).toEqual(OK);
    expect(await run('core.ftp', 'sftp', { ...data, password: 'wrong' })).toEqual({
      status: 'Error',
      message: 'SSH refused the user name, password or key',
    });
  });

  it('refuses a host the SSRF policy blocks, before any connection', async () => {
    const { HttpClient } = await import('@workflow/core');
    const before = ftp.connections;
    const result = await run(
      'core.ftp',
      'ftp',
      { host: '127.0.0.1', port: ftp.port, username: 'tester', password: 'ftp-pw' },
      contextFor(new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } })),
    );
    expect(result.status).toBe('Error');
    expect(ftp.connections).toBe(before);
  });
});

describe('SMTP', () => {
  let smtp: { port: number; close: () => Promise<void>; messages: string[] };

  /** an SMTP server that answers AUTH PLAIN for one user and password only, and records any mail */
  async function startAuthServer() {
    const messages: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let buffer = '';
      socket.write('220 localhost ESMTP test\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (verb === 'AUTH') {
            const plain = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
            if (plain === '\0smtp-user\0smtp-pw') socket.write('235 Authentication successful\r\n');
            else socket.write('535 5.7.8 SERVERTEXT bad credentials\r\n');
          } else if (verb === 'MAIL' || verb === 'DATA') {
            messages.push(line);
            socket.write('250 OK\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      messages,
      close: () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        }),
    };
  }

  beforeAll(async () => {
    smtp = await startAuthServer();
  });
  afterAll(() => smtp.close());

  const data = (extra: DataObject = {}) => ({
    host: '127.0.0.1',
    port: smtp.port,
    secure: false,
    disableStartTls: true,
    user: 'smtp-user',
    password: 'smtp-pw',
    ...extra,
  });

  it('passes with the right password and sends no mail', async () => {
    expect(await run('core.sendEmail', 'smtp', data())).toEqual(OK);
    expect(smtp.messages).toEqual([]);
  });

  it('fails clearly on a wrong password, with no text of the server', async () => {
    const result = await run('core.sendEmail', 'smtp', data({ password: 'wrong-pw-secret' }));
    expect(result).toEqual({
      status: 'Error',
      message: 'The SMTP server refused the user name or password',
    });
  });

  it('fails clearly on a port nothing listens on', async () => {
    const result = await run('core.sendEmail', 'smtp', data({ port: await freePort() }));
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/^Couldn't connect to the SMTP server/);
  });

  it('refuses a host the SSRF policy blocks, before any connection', async () => {
    const { HttpClient } = await import('@workflow/core');
    const result = await run(
      'core.sendEmail',
      'smtp',
      data(),
      contextFor(new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } })),
    );
    expect(result.status).toBe('Error');
  });
});

describe('cancel', () => {
  it('a cancelled test ends without hanging', async () => {
    // a server that accepts and never answers
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(
      'core.sendEmail',
      'smtp',
      { host: '127.0.0.1', port, secure: false, disableStartTls: true },
      contextFor(localHttp(), controller.signal),
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    silent.close();
    expect(result.status).toBe('Error');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
