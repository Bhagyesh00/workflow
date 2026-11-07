/**
 * The guarded MongoDB client without a MongoDB server: an in-process listener speaks just enough of
 * the wire protocol to answer `hello`, and the loopback SOCKS5 guard is checked byte by byte.
 */
import net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Logger, WorkflowNode } from '@workflow/workflow';
import { BSON } from 'mongodb';
import { SocksClient } from 'socks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMongoOptions,
  mongoDbConnectionTest,
  sanitizeMongoError,
  sharedMongo,
  startMongoGuard,
} from '../src/shared/mongo';
import type { ConnectionContext } from '../src/shared/shared-resource';

const PASSWORD = 'S3cret-Pw_42';

interface LogEntry {
  level: string;
  message: string;
  meta?: DataObject;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const at = (level: string) => (message: string, meta?: DataObject) =>
    entries.push({ level, message, meta });
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const http = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
const helpers = {
  resolveAllowedHost: (host: string) => http.resolveAllowedHost(host),
  assertHostAllowed: (host: string) => http.assertHostAllowed(host),
};

let executions = 0;
function connectionContext(credentials: DataObject, log: LogEntry[] = []): ConnectionContext {
  const execution = `guard-${process.pid}-${++executions}`;
  return {
    getCredentials: async () => credentials,
    helpers,
    logger: recordingLogger(log),
    getTenantId: () => 't1',
    getExecutionId: () => execution,
    getNode: () =>
      ({
        id: 'm',
        name: 'Mongo',
        type: 'ai.memoryMongoDbChat',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      }) as WorkflowNode,
  } as unknown as ConnectionContext;
}

function connectionString(url: string): DataObject {
  return { configurationType: 'connectionString', connectionString: url, database: 'db' };
}

/** A listener that answers every command with `hello`: OP_REPLY to OP_QUERY (the first hello), OP_MSG to OP_MSG. */
async function startFakeMongo(hello: DataObject): Promise<{ port: number; close(): Promise<void> }> {
  let nextId = 1;
  const frame = (opCode: number, responseTo: number, body: Buffer) => {
    const header = Buffer.alloc(16);
    header.writeInt32LE(16 + body.length, 0);
    header.writeInt32LE(nextId++, 4);
    header.writeInt32LE(responseTo, 8);
    header.writeInt32LE(opCode, 12);
    return Buffer.concat([header, body]);
  };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 16 && buffer.length >= buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const requestId = buffer.readInt32LE(4);
        const opCode = buffer.readInt32LE(12);
        buffer = buffer.subarray(length);
        const doc = Buffer.from(BSON.serialize({ ...hello, localTime: new Date() }));
        if (opCode === 2004) {
          const reply = Buffer.alloc(20);
          reply.writeInt32LE(1, 16); // numberReturned
          socket.write(frame(1, requestId, Buffer.concat([reply, doc])));
        } else if (opCode === 2013) {
          socket.write(frame(2013, requestId, Buffer.concat([Buffer.alloc(5), doc])));
        } else {
          socket.destroy();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `{ host, port }` of one `net.Socket.prototype.connect` call, whatever form its arguments take */
function target(args: unknown[]): { host?: string; port?: number; lookup?: unknown } {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'number' || typeof first === 'string') {
    return { port: Number(first), host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  const options = (first ?? {}) as { host?: string; port?: number | string; lookup?: unknown };
  return {
    host: options.host,
    port: options.port === undefined ? undefined : Number(options.port),
    lookup: options.lookup,
  };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SECONDARY_HELLO = {
  ok: 1,
  helloOk: true,
  isWritablePrimary: false,
  ismaster: false,
  secondary: true,
  setName: 'rs0',
  hosts: ['10.0.0.5:27017'],
  maxWireVersion: 25,
  minWireVersion: 0,
  maxBsonObjectSize: 16 * 1024 * 1024,
  maxMessageSizeBytes: 48_000_000,
  maxWriteBatchSize: 100_000,
  logicalSessionTimeoutMinutes: 30,
  connectionId: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MongoDB guard: every socket of the driver goes through it', () => {
  it('refuses a private replica member the server lists, with no TCP attempt', async () => {
    const fake = await startFakeMongo(SECONDARY_HELLO);
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const log: LogEntry[] = [];
    const ctx = connectionContext(
      connectionString(
        `mongodb://127.0.0.1:${fake.port}/?replicaSet=rs0&readPreference=secondaryPreferred&serverSelectionTimeoutMS=3000`,
      ),
      log,
    );
    const shared = await sharedMongo(ctx, 0);
    try {
      const guardPort = shared.value.client.options.proxyPort;
      expect(shared.value.client.options.proxyHost).toBe('127.0.0.1');
      expect(guardPort).toBeGreaterThan(0);
      // the driver learns 10.0.0.5 from the seed's hello and its monitor asks the guard for it
      await until(() => log.some((e) => e.level === 'warn' && e.meta?.host === '10.0.0.5'));
      const calls = connect.mock.calls.map((args) => target(args));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((c) => c.port === guardPort)).toBe(true);
      for (const call of calls) {
        expect(call.host).toBe('127.0.0.1');
        if (call.port !== guardPort) {
          // a call from the guard: an allowed destination, through the checked addresses only
          expect(call.port).toBe(fake.port);
          expect(typeof call.lookup).toBe('function');
        }
      }
      expect(calls.some((c) => c.host === '10.0.0.5')).toBe(false);
    } finally {
      await shared.release();
      await fake.close();
    }
  });

  it('never connects to a blocked seed and keeps the password out of the error', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const log: LogEntry[] = [];
    const url = `mongodb://admin:${PASSWORD}@169.254.169.254:27017/?serverSelectionTimeoutMS=1500`;
    const error = await sharedMongo(connectionContext(connectionString(url), log), 0).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/169\.254\.169\.254/);
    expect(error!.message).toMatch(/blocked|not allowed/);
    expect(error!.message).not.toContain(PASSWORD);
    expect(error!.message).not.toContain('mongodb://');
    expect(connect.mock.calls.map((args) => target(args)).some((c) => c.host === '169.254.169.254')).toBe(
      false,
    );
    expect(log.some((e) => e.level === 'warn' && e.meta?.host === '169.254.169.254')).toBe(true);
  });

  it('answers the credential test with the refusal and no secret', async () => {
    const result = await mongoDbConnectionTest(
      { helpers, logger: recordingLogger([]), signal: new AbortController().signal, getTenantId: () => 't1' },
      {
        type: 'mongoDb',
        data: {
          configurationType: 'values',
          host: '10.0.0.5',
          port: 27017,
          user: 'admin',
          password: PASSWORD,
          database: 'db',
        },
      },
    );
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/10\.0\.0\.5/);
    expect(result.message).not.toContain(PASSWORD);
  });
});

describe('MongoDB guard: SOCKS5 listener', () => {
  it('listens on 127.0.0.1 with a random user and password per client', async () => {
    const a = await startMongoGuard({ helpers, logger: recordingLogger([]) });
    const b = await startMongoGuard({ helpers, logger: recordingLogger([]) });
    try {
      expect(a.port).not.toBe(b.port);
      expect(a.username).not.toBe(b.username);
      expect(a.password).not.toBe(b.password);
      expect(a.password.length).toBeGreaterThanOrEqual(32);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('connects an allowed destination and refuses a wrong password or a blocked one', async () => {
    const fake = await startFakeMongo(SECONDARY_HELLO);
    const log: LogEntry[] = [];
    const guard = await startMongoGuard({ helpers, logger: recordingLogger(log) });
    const proxy = (password: string) => ({
      host: '127.0.0.1',
      port: guard.port,
      type: 5 as const,
      userId: guard.username,
      password,
    });
    try {
      const ok = await SocksClient.createConnection({
        command: 'connect',
        proxy: proxy(guard.password),
        destination: { host: '127.0.0.1', port: fake.port },
        timeout: 5000,
      });
      ok.socket.destroy();

      await expect(
        SocksClient.createConnection({
          command: 'connect',
          proxy: proxy(`${guard.password}x`),
          destination: { host: '127.0.0.1', port: fake.port },
          timeout: 5000,
        }),
      ).rejects.toThrow();

      const connect = vi.spyOn(net.Socket.prototype, 'connect');
      for (const host of ['10.0.0.5', '169.254.169.254', 'fd00::1']) {
        await expect(
          SocksClient.createConnection({
            command: 'connect',
            proxy: proxy(guard.password),
            destination: { host, port: 27017 },
            timeout: 5000,
          }),
        ).rejects.toThrow(/NotAllowed|not allowed/i);
      }
      // only the test's own sockets to the guard, none from the guard to a refused address
      const hosts = connect.mock.calls.map((args) => target(args).host);
      expect(hosts.every((h) => h === '127.0.0.1')).toBe(true);
      expect(log.filter((e) => e.level === 'warn').map((e) => e.meta?.host)).toEqual([
        '10.0.0.5',
        '169.254.169.254',
        'fd00:0:0:0:0:0:0:1',
      ]);

      await expect(
        SocksClient.createConnection({
          command: 'bind',
          proxy: proxy(guard.password),
          destination: { host: '127.0.0.1', port: fake.port },
          timeout: 5000,
        }),
      ).rejects.toThrow();
    } finally {
      await guard.close();
      await fake.close();
    }
  });

  it('refuses a client that offers no username and password method', async () => {
    const guard = await startMongoGuard({ helpers, logger: recordingLogger([]) });
    try {
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const socket = net.connect(guard.port, '127.0.0.1', () => socket.write(Buffer.from([5, 1, 0])));
        socket.once('data', (data: Buffer) => {
          socket.destroy();
          resolve(data);
        });
        socket.once('error', reject);
      });
      expect([...reply]).toEqual([5, 0xff]);
    } finally {
      await guard.close();
    }
  });
});

describe('buildMongoOptions', () => {
  const build = (url: string) => () => buildMongoOptions(connectionString(url));

  it.each([
    ['tlsCAFile=/etc/ssl/ca.pem', 'tlsCAFile'],
    ['TLSCAFILE=/x', 'TLSCAFILE'],
    ['tls%43AFile=/x', 'tlsCAFile'],
    ['tlsCertificateKeyFile=/x', 'tlsCertificateKeyFile'],
    ['tlsCRLFile=/x', 'tlsCRLFile'],
    ['proxyHost=10.0.0.9', 'proxyHost'],
    ['authMechanism=MONGODB-OIDC', 'authMechanism'],
    ['authMechanism=MONGODB-AWS', 'authMechanism'],
    ['authMechanism=GSSAPI', 'authMechanism'],
    ['authMechanism=SCRAM-SHA-256&authMechanism=MONGODB-AWS', 'authMechanism'],
    ['authMechanismProperties=ENVIRONMENT:azure', 'authMechanismProperties'],
    ['loadBalanced=true', 'loadBalanced'],
  ])('refuses %s', (query, name) => {
    const url = `mongodb://admin:${PASSWORD}@db.example.com:27017/app?${query}`;
    let error: Error | undefined;
    try {
      buildMongoOptions(connectionString(url));
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toBe(`The connection string option "${name}" is not allowed`);
    expect(error?.message).not.toContain(PASSWORD);
  });

  it('keeps the allowed options and their values', () => {
    const url =
      'mongodb+srv://u:p@cluster0.example.net/app?retryWrites=true&w=majority&appName=x&authSource=admin&authMechanism=SCRAM-SHA-256&replicaSet=rs0&readPreference=secondaryPreferred&maxPoolSize=3&compressors=zlib&serverSelectionTimeoutMS=5000';
    const { url: out, options } = buildMongoOptions(connectionString(url));
    expect(out).toBe(url);
    // the string's own timeout wins, so no object option is set for it
    expect(options.serverSelectionTimeoutMS).toBeUndefined();
    for (const mechanism of ['SCRAM-SHA-1', 'MONGODB-X509', 'PLAIN']) {
      expect(build(`mongodb://h/?authMechanism=${mechanism}`)).not.toThrow();
    }
  });

  it('refuses another scheme', () => {
    expect(build('http://example.com/')).toThrow(/mongodb:\/\/ or mongodb\+srv:\/\//);
  });

  it('builds a values credential with the password as an option and TLS material as driver options', () => {
    const { url, options } = buildMongoOptions({
      configurationType: 'values',
      host: 'db.example.com',
      port: 27018,
      user: 'admin',
      password: PASSWORD,
      database: 'app',
      tls: true,
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      cert: '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----',
      key: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----',
      passphrase: 'pp',
    });
    expect(url).toBe('mongodb://db.example.com:27018/');
    expect(url).not.toContain(PASSWORD);
    expect(options.auth).toEqual({ username: 'admin', password: PASSWORD });
    expect(options.tls).toBe(true);
    expect(options.ca).toContain('CA');
    expect(options.cert).toContain('C');
    expect(options.key).toContain('K');
    expect(options.passphrase).toBe('pp');
    expect(Object.keys(options).some((k) => k.toLowerCase().startsWith('proxy'))).toBe(false);
    expect(() => buildMongoOptions({ configurationType: 'values', host: 'a/b?c', port: 1 })).toThrow();
  });
});

describe('sanitizeMongoError', () => {
  it('removes the password and the whole connection string', () => {
    const url = `mongodb://admin:${encodeURIComponent(PASSWORD)}@db.example.com:27017/app?tls=true`;
    const credentials = { configurationType: 'connectionString', connectionString: url };
    const error = sanitizeMongoError(
      new Error(`Could not connect with ${url}, password ${PASSWORD} rejected`),
      credentials,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain('db.example.com:27017/app');
    expect(error.message).not.toContain('mongodb://');
    expect(sanitizeMongoError('plain text', { password: 'zz9' }).message).toBe('plain text');
    const values = sanitizeMongoError(new Error(`auth failed for ${PASSWORD}`), { password: PASSWORD });
    expect(values.message).not.toContain(PASSWORD);
  });
});
