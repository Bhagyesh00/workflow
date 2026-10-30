import dns from 'node:dns';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient, SsrfBlockedError } from '../src';

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('SSRF guard on redirects', () => {
  const internal = http.createServer((_req, res) => res.end('INTERNAL-SECRET'));
  const internalAlt = http.createServer((_req, res) => res.end('INTERNAL-SECRET'));
  let front: http.Server;
  let internalPort = 0;
  let internalAltPort = 0;
  let frontPort = 0;

  beforeAll(async () => {
    internalPort = await listen(internal, '127.0.0.1');
    internalAltPort = await listen(internalAlt, '127.0.0.2');
    front = http.createServer((req, res) => {
      const targets: Record<string, string> = {
        '/to-loopback': `http://127.0.0.1:${internalPort}/x`,
        '/to-loopback-alt': `http://127.0.0.2:${internalAltPort}/x`,
        '/to-allowed': `http://localhost:${frontPort}/ok`,
        '/chain': `http://localhost:${frontPort}/to-loopback`,
      };
      const target = targets[req.url ?? ''];
      if (target) {
        res.writeHead(302, { location: target });
        res.end();
      } else res.end('OK');
    });
    frontPort = await listen(front, '127.0.0.1');
  });

  afterAll(async () => {
    await Promise.all([close(internal), close(internalAlt), close(front)]);
  });

  // `allow: ['localhost']` stands in for a public attacker host that passes the policy
  const client = () => new HttpClient({ ssrf: { allow: ['localhost'] } });

  it.each(['/to-loopback', '/to-loopback-alt', '/chain'])(
    'blocks a redirect from an allowed host to a loopback IP literal (%s)',
    async (path) => {
      const c = client();
      try {
        await expect(c.request({ url: `http://localhost:${frontPort}${path}` })).rejects.toThrow(
          SsrfBlockedError,
        );
      } finally {
        await c.close();
      }
    },
  );

  it('still follows redirects between allowed hosts', async () => {
    const c = client();
    try {
      await expect(c.request({ url: `http://localhost:${frontPort}/to-allowed` })).resolves.toBe('OK');
    } finally {
      await c.close();
    }
  });

  it('rejects a disallowed IP literal at connect time even when the pre-check is skipped', async () => {
    const c = client();
    try {
      // the pre-check runs on the first URL only; the connect hook is the check every hop goes through
      Object.defineProperty(c, 'assertUrlAllowed', { value: () => undefined });
      await expect(c.request({ url: `http://127.0.0.1:${internalPort}/x` })).rejects.toThrow(
        SsrfBlockedError,
      );
    } finally {
      await c.close();
    }
  });
});

describe('pinned resolution for non-HTTP connections', () => {
  const DUAL = 'dual.test';
  const realPromisesLookup = dns.promises.lookup;
  const realLookup = dns.lookup;
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `dual.test` resolves to an IPv6 address nothing listens on, then to the IPv4 one the server uses */
  function dualStackDns() {
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

  const client = () => new HttpClient({ ssrf: { allow: [DUAL] } });

  it('returns every checked address and a lookup that answers only from them', async () => {
    dualStackDns();
    const c = client();
    try {
      const allowed = await c.resolveAllowedHost(DUAL);
      expect(allowed.addresses).toEqual([
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
      const answer = (options: { all?: boolean; family?: number | string }) =>
        new Promise<unknown[]>((resolve, reject) =>
          allowed.lookup(DUAL, options, (error, address, family) =>
            error ? reject(error) : resolve([address, family]),
          ),
        );
      await expect(answer({ all: true })).resolves.toEqual([allowed.addresses, undefined]);
      await expect(answer({})).resolves.toEqual(['::1', 6]);
      await expect(answer({ family: 4 })).resolves.toEqual(['127.0.0.1', 4]);
      await expect(answer({ family: 'IPv6', all: true })).resolves.toEqual([
        [{ address: '::1', family: 6 }],
        undefined,
      ]);
    } finally {
      await c.close();
    }
  });

  it('falls back to the next checked address without resolving the name again', async () => {
    const lookup = dualStackDns();
    const c = client();
    try {
      const allowed = await c.resolveAllowedHost(DUAL);
      const remote = await new Promise<string | undefined>((resolve, reject) => {
        const socket = net.connect({ host: DUAL, port, lookup: allowed.lookup, autoSelectFamily: true });
        socket.once('connect', () => {
          resolve(socket.remoteAddress);
          socket.destroy();
        });
        socket.once('error', reject);
      });
      expect(remote).toBe('127.0.0.1');
      expect(lookup.mock.calls.some(([host]) => host === DUAL)).toBe(false);
    } finally {
      await c.close();
    }
  });

  it('rejects the host when any of its addresses is blocked', async () => {
    dualStackDns();
    const c = new HttpClient();
    try {
      await expect(c.resolveAllowedHost(DUAL)).rejects.toThrow(SsrfBlockedError);
    } finally {
      await c.close();
    }
  });
});
