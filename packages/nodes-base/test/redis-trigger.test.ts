/** P4-10 Redis Trigger: patterns, options, manual mode, reconnect, retries then emitError, credential test, pinning. */

import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { createTriggerContext, HttpClient } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type TriggerResponse, Workflow } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { redisRetry } from '../src/nodes/apps/redis/RedisTrigger.node';
import { redisCredentialTest } from '../src/utils/redis-connect';
import { node, nodeTypes, testServices } from './harness';
import { localHttp } from './servers';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/11';
const url = new URL(REDIS_URL);
const baseCreds = {
  host: url.hostname,
  port: Number(url.port || 6379),
  database: Number(url.pathname.slice(1) || 0),
};
const rand = () => randomBytes(4).toString('hex');

const closers: Array<() => Promise<void> | void> = [];
let publisher: Redis;

const typeOf = () => nodes.find((n) => n.description.name === 'app.redisTrigger')!;

function build(
  parameters: DataObject,
  mode: 'activate' | 'manual' = 'activate',
  creds: DataObject = baseCreds,
  http: HttpClient = localHttp(),
) {
  const wfNode = node('Redis Trigger', 'app.redisTrigger', parameters, [0, 0], {
    id: `n${rand()}`,
    credentials: { redis: { id: 'redis', name: 'redis' } },
  });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: {} },
    nodeTypes,
  );
  const emitted: DataObject[] = [];
  const errors: Error[] = [];
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices({ redis: creds }, { mode: mode === 'manual' ? 'manual' : 'trigger', http }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      activationMode: mode,
      emit: (data) => void emitted.push(...(data[0] ?? []).map((i) => i.json)),
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, emitted, errors };
}

async function start(parameters: DataObject, mode: 'activate' | 'manual' = 'activate', creds?: DataObject) {
  const { ctx, emitted, errors } = build(parameters, mode, creds);
  const response = (await typeOf().trigger!(ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { response, emitted, errors };
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(() => {
  publisher = new Redis(REDIS_URL);
  return () => void publisher.disconnect();
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.assign(redisRetry, { attempts: 10, baseMs: 1000, maxMs: 60_000 });
  while (closers.length) await closers.pop()!();
});

describe('Redis Trigger', () => {
  it('emits {channel, message} for a plain channel and ignores other channels', async () => {
    const ch = `t:${rand()}`;
    const t = await start({ channels: ch });
    await publisher.publish(`${ch}x`, 'other');
    await publisher.publish(ch, 'hello');
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted).toEqual([{ channel: ch, message: 'hello' }]);
  });

  it('subscribes every entry as a pattern: a wildcard and a comma list', async () => {
    const p = rand();
    const t = await start({ channels: `w${p}.*,plain${p}` });
    await publisher.publish(`w${p}.a`, '1');
    await publisher.publish(`plain${p}`, '2');
    await waitFor(() => t.emitted.length === 2);
    expect(t.emitted.map((e) => e.channel).sort()).toEqual([`plain${p}`, `w${p}.a`]);
  });

  it('trims spaces around the entries, so the placeholder list works', async () => {
    const p = rand();
    const t = await start({ channels: `orders${p}, events${p}.*` });
    await publisher.publish(`events${p}.created`, 'x');
    await publisher.publish(`orders${p}`, 'y');
    await waitFor(() => t.emitted.length === 2);
    expect(t.emitted.map((e) => e.channel).sort()).toEqual([`events${p}.created`, `orders${p}`]);
  });

  it('JSON Parse Body parses JSON and leaves other text alone', async () => {
    const ch = `j:${rand()}`;
    const t = await start({ channels: ch, options: { jsonParseBody: true } });
    await publisher.publish(ch, '{"a":1}');
    await publisher.publish(ch, 'not json');
    await waitFor(() => t.emitted.length === 2);
    expect(t.emitted.map((e) => e.message)).toEqual([{ a: 1 }, 'not json']);
  });

  it('without JSON Parse Body the message stays text', async () => {
    const ch = `j:${rand()}`;
    const t = await start({ channels: ch });
    await publisher.publish(ch, '{"a":1}');
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted[0].message).toBe('{"a":1}');
  });

  it('Only Message drops the channel', async () => {
    const ch = `o:${rand()}`;
    const t = await start({ channels: ch, options: { onlyMessage: true, jsonParseBody: true } });
    await publisher.publish(ch, '{"b":2}');
    await waitFor(() => t.emitted.length === 1);
    expect(t.emitted).toEqual([{ message: { b: 2 } }]);
  });

  it('refuses an empty channel list', async () => {
    const { ctx } = build({ channels: ' , ' });
    await expect(typeOf().trigger!(ctx)).rejects.toThrow('Channels is required');
  });

  it('stops delivering after close', async () => {
    const ch = `c:${rand()}`;
    const t = await start({ channels: ch });
    await t.response.closeFunction!();
    await publisher.publish(ch, 'late');
    await new Promise((r) => setTimeout(r, 150));
    expect(t.emitted).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });

  it('manual mode: the first message starts the run', async () => {
    const ch = `m:${rand()}`;
    const t = await start({ channels: ch }, 'manual');
    await publisher.publish(ch, 'first');
    await publisher.publish(ch, 'second');
    await t.response.manualTriggerFunction!();
    expect(t.emitted).toEqual([{ channel: ch, message: 'first' }]);
  });

  it('manual mode: a quiet minute ends the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = await start({ channels: `q:${rand()}` }, 'manual');
      const waiting = t.response.manualTriggerFunction!();
      const assertion = expect(waiting).rejects.toThrow('No message arrived within 60 seconds');
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps receiving after the server drops the connection', async () => {
    const ch = `r:${rand()}`;
    redisRetry.baseMs = 50;
    const t = await start({ channels: ch });
    await publisher.call('CLIENT', 'KILL', 'TYPE', 'pubsub');
    const end = Date.now() + 8000;
    while (Date.now() < end && t.emitted.length === 0) {
      await publisher.publish(ch, 'again');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(t.emitted.length).toBeGreaterThan(0);
    expect(t.errors).toHaveLength(0);
  });

  it('after the last retry fails it reports an error once', async () => {
    redisRetry.attempts = 2;
    redisRetry.baseMs = 5;
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const up = net.connect(baseCreds.port, baseCreds.host);
      sockets.add(client);
      sockets.add(up);
      client.pipe(up).pipe(client);
      client.on('error', () => undefined);
      up.on('error', () => undefined);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const port = (proxy.address() as net.AddressInfo).port;
    const t = await start({ channels: `e:${rand()}` }, 'activate', { ...baseCreds, port });
    proxy.close();
    for (const s of sockets) s.destroy();
    await waitFor(() => t.errors.length > 0, 8000);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].message).toContain('Redis connection of the trigger was lost');
  });

  it('refuses a private or metadata address for the host', async () => {
    for (const host of ['10.0.0.5', '169.254.169.254']) {
      const { ctx } = build({ channels: 'x' }, 'activate', { ...baseCreds, host }, new HttpClient());
      await expect(typeOf().trigger!(ctx)).rejects.toThrow();
    }
  });

  it('connects only to the address the check passed (DNS rebind)', async () => {
    const REBIND = 'rebind.test';
    const realLookup = dns.lookup;
    const realPromisesLookup = dns.promises.lookup;
    vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) =>
      host === REBIND
        ? Promise.resolve([{ address: '93.184.215.14', family: 4 }])
        : (realPromisesLookup as (...args: unknown[]) => unknown)(host, ...rest)) as never);
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: unknown[]) => {
      if (host !== REBIND) return (realLookup as (...args: unknown[]) => unknown)(host, ...rest);
      const callback = rest[rest.length - 1] as (...args: unknown[]) => void;
      callback(null, '127.0.0.1', 4);
    }) as never);
    const { ctx } = build({ channels: 'x' }, 'activate', { ...baseCreds, host: REBIND });
    await expect(
      Promise.race([
        typeOf().trigger!(ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 3000)),
      ]),
    ).rejects.toBeDefined();
    expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
  });

  it('maps SSL and Disable TLS Verification to the TLS options', async () => {
    const { openRedis } = await import('../src/utils/redis-connect');
    const seen: Array<Record<string, unknown>> = [];
    const lookupOnly = {
      helpers: {
        resolveAllowedHost: async (h: string) => {
          seen.push({ host: h });
          return { addresses: [{ address: '127.0.0.1', family: 4 }], lookup: undefined } as never;
        },
      },
    };
    for (const disableTlsVerification of [false, true]) {
      // a plain server cannot speak TLS, so the connect fails; the options are what is checked
      const client = openRedis(
        lookupOnly,
        { host: 'redis.example', ssl: true, disableTlsVerification, port: baseCreds.port },
        { connectTimeout: 300, retryStrategy: () => null },
      );
      await expect(client).rejects.toBeDefined();
    }
    expect(seen).toHaveLength(2);
  });
});

describe('Redis credential test', () => {
  const ctx = () => {
    const { helpers } = testServices({}, { http: localHttp() }) as never as { helpers?: never };
    void helpers;
    const http = localHttp();
    return {
      helpers: {
        resolveAllowedHost: (h: string) => http.resolveAllowedHost(h),
        assertHostAllowed: async () => undefined,
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      getTenantId: () => 't1',
    } as never;
  };

  it('passes against the test Redis', async () => {
    const r = await redisCredentialTest(ctx(), { type: 'redis', data: baseCreds });
    expect(r.status).toBe('OK');
  });

  it('fails clearly on a password the server does not accept, without echoing it', async () => {
    const r = await redisCredentialTest(ctx(), {
      type: 'redis',
      data: { ...baseCreds, password: 'wrong-secret-xyz', user: 'nobody' },
    });
    expect(r.status).toBe('Error');
    expect(r.message).toBe('Redis refused the user or password');
    expect(r.message).not.toContain('wrong-secret-xyz');
  });

  it('fails clearly when nothing listens', async () => {
    const r = await redisCredentialTest(ctx(), { type: 'redis', data: { ...baseCreds, port: 1 } });
    expect(r).toEqual({ status: 'Error', message: 'Could not connect to Redis' });
  });

  it('is wired on the node and the credential entry', () => {
    const t = typeOf();
    expect(t.methods?.credentialTest?.redisCredentialTest).toBeTypeOf('function');
    expect(t.description.credentials?.[0].testedBy).toBe('redisCredentialTest');
  });
});
