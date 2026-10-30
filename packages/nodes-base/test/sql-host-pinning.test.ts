import dns from 'node:dns';
import net, { type AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject } from '@workflow/workflow';
import nodemailer from 'nodemailer';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mysqlPool } from '../src/nodes/apps/sql/MySql.node';
import { postgresPool } from '../src/nodes/apps/sql/Postgres.node';
import { contextFor } from './contexts';
import { runNode } from './harness';

const REBIND = 'rebind.test';
const PUBLIC = '93.184.215.14';
const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;

/**
 * A rebinding name: the SSRF check (dns.promises.lookup) sees a public address, while a driver that
 * resolves the name again at connect time (dns.lookup, as net.connect does) gets loopback.
 */
function rebindDns() {
  vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
    host === REBIND
      ? Promise.resolve([{ address: PUBLIC, family: 4 }])
      : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
  return vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
    if (host !== REBIND) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
    const callback = rest[rest.length - 1] as (...args: unknown[]) => void;
    const options = rest.length > 1 ? (rest[0] as { all?: boolean }) : {};
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as never);
}

const resolvedRebind = (lookup: ReturnType<typeof rebindDns>) =>
  lookup.mock.calls.some(([host]) => host === REBIND);

const loadContext = (type: string, creds: Record<string, DataObject>, http?: HttpClient) =>
  contextFor(type, {}, { creds, services: http ? { http } : {} }).loadOptions();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Postgres host pinning', () => {
  const creds = (host: string, extra: DataObject = {}) => ({
    postgres: { host, port: 5432, database: 'nodes_test', user: 'postgres', password: 'postgres', ...extra },
  });

  it('does not reach loopback when the name rebinds after the SSRF check', async () => {
    const lookup = rebindDns();
    const r = await runNode(
      'app.postgres',
      {
        operation: 'executeQuery',
        query: 'select inet_server_addr()::text as addr',
        options: { connectionTimeout: 1 },
      },
      [{ json: {} }],
      { creds: creds(REBIND) },
    );
    expect(r.outputs[0]?.[0]).toBeUndefined();
    expect(r.status).toBe('error');
    expect(resolvedRebind(lookup)).toBe(false);
  });

  it('connects to the checked address and keeps the hostname for TLS', async () => {
    const lookup = rebindDns();
    const pool = await postgresPool(loadContext('app.postgres', creds(REBIND, { ssl: 'require' })), {
      connectionTimeoutSeconds: 1,
    });
    try {
      await expect(pool.connect()).rejects.toThrow();
      expect(resolvedRebind(lookup)).toBe(false);
      const options = (pool as unknown as { options: pg.PoolConfig }).options;
      // pg takes the TLS server name from `host`
      expect(options.host).toBe(REBIND);
      expect(options.ssl).toMatchObject({ rejectUnauthorized: true });
    } finally {
      await pool.end();
    }
  });

  it('refuses a Unix socket path as the host', async () => {
    await expect(postgresPool(loadContext('app.postgres', creds('/var/run/postgresql')))).rejects.toThrow(
      /unix socket/,
    );
  });
});

describe('MySQL host pinning', () => {
  it('connects to the checked address and keeps the hostname for TLS', async () => {
    const lookup = rebindDns();
    const pool = await mysqlPool(
      loadContext('app.mySql', {
        mySql: { host: REBIND, port: 3306, user: 'root', password: 'pw', ssl: 'require' },
      }),
      { connectionTimeoutSeconds: 1 },
    );
    try {
      await expect(pool.getConnection()).rejects.toThrow();
      expect(resolvedRebind(lookup)).toBe(false);
      const config = (pool as unknown as { pool: { config: { connectionConfig: { host: string } } } }).pool
        .config.connectionConfig;
      // mysql2 takes the TLS server name from `host`
      expect(config.host).toBe(REBIND);
    } finally {
      await pool.end();
    }
  });
});

describe('Send Email host pinning', () => {
  it('connects nodemailer to the checked address and keeps the hostname for TLS', async () => {
    const lookup = rebindDns();
    let transportOptions: Record<string, unknown> = {};
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: Record<string, unknown>) => {
      transportOptions = options;
      return {
        sendMail: async () => ({
          messageId: 'm1',
          accepted: ['b@example.com'],
          rejected: [],
          response: '250 OK',
        }),
        close: () => undefined,
      };
    }) as never);
    const r = await runNode(
      'core.sendEmail',
      { fromEmail: 'a@example.com', toEmail: 'b@example.com', subject: 'Hi', emailFormat: 'text', text: 'x' },
      [{ json: {} }],
      { creds: { smtp: { host: REBIND, port: 465, secure: true } } },
    );
    expect(r.status).toBe('success');
    // nodemailer takes the TLS server name from `host`
    expect(transportOptions.host).toBe(REBIND);
    expect(transportOptions.tls).toMatchObject({ rejectUnauthorized: true });
    const getSocket = transportOptions.getSocket as (
      options: object,
      callback: (error: Error | null, result?: { connection: net.Socket }) => void,
    ) => void;
    const target = await new Promise<string>((resolve, reject) =>
      getSocket({}, (error, result) => {
        if (error || !result) return reject(error);
        result.connection.once('lookup', (_error: Error | null, address: string) => {
          result.connection.destroy();
          resolve(address);
        });
        result.connection.once('error', () => undefined);
      }),
    );
    expect(target).toBe(PUBLIC);
    expect(resolvedRebind(lookup)).toBe(false);
  });
});

describe('fallback across every checked address', () => {
  // `dual.test` resolves to an IPv6 address nothing listens on, then to the IPv4 address the server uses
  const DUAL = 'dual.test';
  const http = new HttpClient({ ssrf: { allow: [DUAL] } });
  const accepted: string[] = [];
  let onConnection: (socket: net.Socket) => void = (socket) => socket.destroy();
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      accepted.push(socket.remoteAddress ?? '');
      socket.on('error', () => undefined);
      onConnection(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await http.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function dualStackDns() {
    accepted.length = 0;
    onConnection = (socket) => socket.destroy();
    vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
      host === DUAL
        ? Promise.resolve([
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ])
        : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
    return vi
      .spyOn(dns, 'lookup')
      .mockImplementation(((host: string, ...rest: unknown[]) =>
        (realLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
  }

  const resolvedDual = (lookup: ReturnType<typeof dualStackDns>) =>
    lookup.mock.calls.some(([host]) => host === DUAL);

  it('Postgres reaches the IPv4 address after the IPv6 one refuses', async () => {
    const lookup = dualStackDns();
    const pool = await postgresPool(
      loadContext('app.postgres', { postgres: { host: DUAL, port, user: 'postgres', password: 'pw' } }, http),
      { connectionTimeoutSeconds: 5 },
    );
    try {
      await expect(pool.connect()).rejects.toThrow();
      expect(accepted).toEqual(['127.0.0.1']);
      expect(resolvedDual(lookup)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('MySQL reaches the IPv4 address after the IPv6 one refuses', async () => {
    const lookup = dualStackDns();
    const pool = await mysqlPool(
      loadContext('app.mySql', { mySql: { host: DUAL, port, user: 'root', password: 'pw' } }, http),
      { connectionTimeoutSeconds: 5 },
    );
    try {
      await expect(pool.getConnection()).rejects.toThrow();
      expect(accepted).toEqual(['127.0.0.1']);
      expect(resolvedDual(lookup)).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('Send Email delivers through the IPv4 address after the IPv6 one refuses', async () => {
    const lookup = dualStackDns();
    onConnection = smtpSession;
    const r = await runNode(
      'core.sendEmail',
      { fromEmail: 'a@example.com', toEmail: 'b@example.com', subject: 'Hi', emailFormat: 'text', text: 'x' },
      [{ json: {} }],
      { creds: { smtp: { host: DUAL, port, secure: false, disableStartTls: true } }, services: { http } },
    );
    expect(r.status).toBe('success');
    expect(accepted).toEqual(['127.0.0.1']);
    expect(resolvedDual(lookup)).toBe(false);
  });
});

/** A minimal SMTP server session: greets, accepts every command and one message, then says goodbye. */
function smtpSession(socket: net.Socket) {
  let buffer = '';
  let inData = false;
  socket.write('220 test ESMTP\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 queued\r\n');
        continue;
      }
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return;
      const command = buffer.slice(0, eol).toUpperCase();
      buffer = buffer.slice(eol + 2);
      if (command.startsWith('EHLO')) socket.write('250-test\r\n250 8BITMIME\r\n');
      else if (command.startsWith('DATA')) {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (command.startsWith('QUIT')) socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
}
