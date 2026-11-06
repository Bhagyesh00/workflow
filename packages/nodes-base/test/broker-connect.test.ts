/** P4-21 broker-connect: every socket goes to the checked addresses of a host, with or without TLS. */
import net from 'node:net';
import tls from 'node:tls';
import { HttpClient } from '@workflow/core';
import type { AllowedHost } from '@workflow/workflow';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectGuarded,
  type GuardedConnectContext,
  guardedLookup,
  tlsOptions,
} from '../src/utils/broker-connect';

// a self-signed test certificate for broker.test, localhost and 127.0.0.1; it protects nothing
const CERT = `-----BEGIN CERTIFICATE-----
MIIBrDCCAVKgAwIBAgIUPkgVQRJwVDXWjab8SB8jyRvUygwwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLYnJva2VyLnRlc3QwIBcNMjYxMTA2MDgwNDM0WhgPMjEyNjEw
MTMwODA0MzRaMBYxFDASBgNVBAMMC2Jyb2tlci50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEhvia5vaRKcBFhOzyvJ91dah1jBRvVUJOB6tVAGO8l5CFwB/z
D1gBfxOPV6VFCQlszbSNoGfYyP8eKe1lZjGQd6N8MHowHQYDVR0OBBYEFPLV7Mij
9HOPsm20BUYrHsBoI+EdMB8GA1UdIwQYMBaAFPLV7Mij9HOPsm20BUYrHsBoI+Ed
MA8GA1UdEwEB/wQFMAMBAf8wJwYDVR0RBCAwHoILYnJva2VyLnRlc3SCCWxvY2Fs
aG9zdIcEfwAAATAKBggqhkjOPQQDAgNIADBFAiBdg0KX0skaPfudE/OBdTejd7Rk
NF+K+W+YgeP2Y7jhIAIhAK4MdFhCx/y6UktEA3JHxN589duU9gCzrip6+7XqGqLr
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgg/sMhjgnYQW2+HpK
62tOMv/dgxN8QIJshqTYzLYJBUmhRANCAASG+Jrm9pEpwEWE7PK8n3V1qHWMFG9V
Qk4Hq1UAY7yXkIXAH/MPWAF/E49XpUUJCWzNtI2gZ9jI/x4p7WVmMZB3
-----END PRIVATE KEY-----
`;

/** a context that checks every name, and answers each with 127.0.0.1 whatever DNS says */
function pinnedContext() {
  const checked: string[] = [];
  const ctx: GuardedConnectContext = {
    helpers: {
      resolveAllowedHost: async (host) => {
        checked.push(host);
        const addresses = [{ address: '127.0.0.1', family: 4 }];
        const lookup: AllowedHost['lookup'] = (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, '127.0.0.1', 4);
        };
        return { addresses, lookup };
      },
    },
  };
  return { ctx, checked };
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

const opened = <T extends net.Socket>(socket: T) => {
  closers.push(() => socket.destroy());
  return socket;
};

function tlsServer() {
  const seen: { servername?: unknown } = {};
  const server = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
    seen.servername = socket.servername;
    socket.end('hello');
  });
  return { server, seen };
}

const firstData = (socket: net.Socket) =>
  new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
  });

describe('guardedLookup', () => {
  it('checks the host and answers from the checked addresses', async () => {
    const { ctx, checked } = pinnedContext();
    const lookup = await guardedLookup(ctx, 'other-broker.test');
    expect(checked).toEqual(['other-broker.test']);
    const answer = await new Promise((resolve, reject) => {
      lookup('other-broker.test', {}, (error, address) => (error ? reject(error) : resolve(address)));
    });
    expect(answer).toBe('127.0.0.1');
  });

  it('refuses a private address behind the guard', async () => {
    const http = new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } });
    const ctx: GuardedConnectContext = { helpers: { resolveAllowedHost: (h) => http.resolveAllowedHost(h) } };
    await expect(guardedLookup(ctx, '127.0.0.1')).rejects.toThrow();
    await expect(guardedLookup(ctx, '10.0.0.1')).rejects.toThrow();
  });
});

describe('connectGuarded', () => {
  it('connects to the checked address of a name DNS does not know', async () => {
    const server = net.createServer((socket) => socket.end('plain'));
    const port = await listen(server);
    const { ctx, checked } = pinnedContext();
    const socket = opened(await connectGuarded(ctx, { host: 'broker.test', port }));
    expect(socket.remoteAddress).toBe('127.0.0.1');
    expect(checked).toEqual(['broker.test']);
    expect(await firstData(socket)).toBe('plain');
  });

  it('opens nothing when the guard refuses the host', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.end();
    });
    const port = await listen(server);
    const http = new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } });
    const ctx: GuardedConnectContext = { helpers: { resolveAllowedHost: (h) => http.resolveAllowedHost(h) } };
    await expect(connectGuarded(ctx, { host: '127.0.0.1', port })).rejects.toThrow();
    await expect(
      connectGuarded(ctx, { host: '127.0.0.1', port, tls: { rejectUnauthorized: false } }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });

  it('connects through the guard when the policy allows the host', async () => {
    const server = net.createServer((socket) => socket.end('allowed'));
    const port = await listen(server);
    const http = new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } });
    const ctx: GuardedConnectContext = { helpers: { resolveAllowedHost: (h) => http.resolveAllowedHost(h) } };
    expect(await firstData(opened(await connectGuarded(ctx, { host: '127.0.0.1', port })))).toBe('allowed');
  });

  it('rejects when nothing listens', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const { ctx } = pinnedContext();
    await expect(connectGuarded(ctx, { host: 'broker.test', port })).rejects.toThrow();
  });

  it('gives up after the time limit', async () => {
    const { ctx } = pinnedContext();
    // nothing answers the TLS handshake of a server that only accepts the connection
    const server = net.createServer(() => {});
    const port = await listen(server);
    await expect(
      connectGuarded(ctx, { host: 'broker.test', port, tls: {}, timeoutMs: 100 }),
    ).rejects.toThrow('Timed out connecting to broker.test');
  });

  it('TLS: sends the host as the server name and verifies against it', async () => {
    const { server, seen } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    const socket = opened(await connectGuarded(ctx, { host: 'broker.test', port, tls: { ca: CERT } }));
    expect(socket).toBeInstanceOf(tls.TLSSocket);
    expect((socket as tls.TLSSocket).authorized).toBe(true);
    expect(await firstData(socket)).toBe('hello');
    expect(seen.servername).toBe('broker.test');
  });

  it('TLS: a server name of the caller does not replace the host', async () => {
    const { server, seen } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    const socket = opened(
      await connectGuarded(ctx, { host: 'broker.test', port, tls: { ca: CERT, servername: 'elsewhere.test' } }),
    );
    expect(await firstData(socket)).toBe('hello');
    expect(seen.servername).toBe('broker.test');
  });

  it('TLS: refuses a certificate that does not name the host', async () => {
    const { server } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    await expect(connectGuarded(ctx, { host: 'wrong.test', port, tls: { ca: CERT } })).rejects.toThrow();
  });

  it('TLS: refuses an unknown certificate unless told not to verify', async () => {
    const { server } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    await expect(connectGuarded(ctx, { host: 'broker.test', port, tls: {} })).rejects.toThrow();
    const socket = opened(
      await connectGuarded(ctx, { host: 'broker.test', port, tls: { rejectUnauthorized: false } }),
    );
    expect(await firstData(socket)).toBe('hello');
  });

  it('TLS: an IP literal sends no server name', async () => {
    const { server, seen } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    const socket = opened(await connectGuarded(ctx, { host: '127.0.0.1', port, tls: { ca: CERT } }));
    expect((socket as tls.TLSSocket).authorized).toBe(true);
    expect(await firstData(socket)).toBe('hello');
    expect(seen.servername).toBeFalsy();
  });
});

describe('tlsOptions', () => {
  it('is empty for empty fields, so Node verifies by default', () => {
    expect(tlsOptions({})).toEqual({});
    expect(tlsOptions({ ca: '', cert: ' ', key: '', passphrase: '' })).toEqual({});
  });

  it('re-wraps PEM text pasted with literal line breaks', () => {
    const pasted = CERT.trim().replaceAll('\n', '\\n');
    expect(tlsOptions({ ca: pasted }).ca).toBe(CERT);
    expect(tlsOptions({ cert: pasted }).cert).toBe(CERT);
    expect(tlsOptions({ key: KEY.trim().replaceAll('\n', ' \\n') }).key).toContain('BEGIN PRIVATE KEY');
  });

  it('keeps the passphrase as typed', () => {
    expect(tlsOptions({ key: KEY, passphrase: ' secret ' }).passphrase).toBe(' secret ');
  });

  it('turns verification off only when asked', () => {
    expect(tlsOptions({ rejectUnauthorized: false }).rejectUnauthorized).toBe(false);
    expect(tlsOptions({ rejectUnauthorized: true }).rejectUnauthorized).toBe(true);
    expect('rejectUnauthorized' in tlsOptions({ ca: CERT })).toBe(false);
  });

  it('builds options a real TLS connection takes', async () => {
    const { server } = tlsServer();
    const port = await listen(server);
    const { ctx } = pinnedContext();
    const socket = opened(
      await connectGuarded(ctx, { host: 'broker.test', port, tls: tlsOptions({ ca: CERT }) }),
    );
    expect(await firstData(socket)).toBe('hello');
  });
});
