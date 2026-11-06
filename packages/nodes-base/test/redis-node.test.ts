/** P4-24 Redis node: the ten operations against the test Redis (db 11), errors, continue on fail, host guard. */
import { randomBytes } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import type { DataObject } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { runNode } from './harness';
import { localHttp } from './servers';

const url = new URL(process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/11');
const creds = { host: url.hostname, port: Number(url.port || 6379), database: Number(url.pathname.slice(1) || 0) };
const rand = () => randomBytes(4).toString('hex');
const prefix = `p424-${rand()}`;
const k = (name: string) => `${prefix}:${name}`;

let direct: Redis;
beforeAll(async () => {
  direct = new Redis({ host: creds.host, port: creds.port, db: creds.database });
});
afterAll(async () => {
  const keys = await direct.keys(`${prefix}:*`);
  if (keys.length) await direct.del(...keys);
  direct.disconnect();
});

const run = (parameters: Record<string, unknown>, input: Array<{ json: DataObject }> = [{ json: { a: 1 } }], continueOnFail = false) =>
  runNode('app.redis', parameters as never, input, {
    creds: { redis: creds },
    node: continueOnFail ? { onError: 'continueRegularOutput' } : {},
    services: { http: localHttp() },
  });

describe('Redis node', () => {
  it('has all ten operations, each with an action', () => {
    const type = nodes.find((n) => n.description.name === 'app.redis')!;
    const operation = type.description.properties.find((p) => p.name === 'operation')!;
    const values = (operation.options as Array<{ value: string; action?: string }>).map((o) => o.value);
    expect(values.sort()).toEqual(['delete', 'get', 'incr', 'info', 'keys', 'llen', 'pop', 'publish', 'push', 'set']);
    for (const o of operation.options as Array<{ action?: string }>) expect(o.action).toBeTruthy();
  });

  it('set then get a string, keeping the input item fields', async () => {
    const set = await run({ operation: 'set', key: k('s'), value: 'hello', valueType: 'string' });
    expect(set.status).toBe('success');
    expect(set.outputs[0]).toEqual([{ a: 1 }]);
    expect(await direct.get(k('s'))).toBe('hello');
    const got = await run({ operation: 'get', key: k('s'), propertyName: 'v' });
    expect(got.outputs[0]).toEqual([{ a: 1, v: 'hello' }]);
  });

  it('get writes a nested path with dot notation and a flat name without it', async () => {
    await direct.set(k('n'), 'x');
    const nested = await run({ operation: 'get', key: k('n'), propertyName: 'a.b' }, [{ json: {} }]);
    expect(nested.outputs[0]).toEqual([{ a: { b: 'x' } }]);
    const flat = await run(
      { operation: 'get', key: k('n'), propertyName: 'a.b', options: { dotNotation: false } },
      [{ json: {} }],
    );
    expect(flat.outputs[0]).toEqual([{ 'a.b': 'x' }]);
  });

  it('get returns null for a missing key', async () => {
    const got = await run({ operation: 'get', key: k('missing'), propertyName: 'v' }, [{ json: {} }]);
    expect(got.outputs[0]).toEqual([{ v: null }]);
  });

  it('set stores hash, list and set values; automatic picks the type; get reads them back', async () => {
    await run({ operation: 'set', key: k('h'), value: '{"f":"1","g":2}', valueType: 'hash' });
    expect(await direct.hgetall(k('h'))).toEqual({ f: '1', g: '2' });
    await run({ operation: 'set', key: k('l'), value: '["a","b"]', valueType: 'list' });
    expect(await direct.lrange(k('l'), 0, -1)).toEqual(['a', 'b']);
    await run({ operation: 'set', key: k('set'), value: '["x","y"]', valueType: 'sets' });
    expect((await direct.smembers(k('set'))).sort()).toEqual(['x', 'y']);
    await run({ operation: 'set', key: k('auto'), value: '{"q":"1"}' });
    expect(await direct.type(k('auto'))).toBe('hash');
    const got = await run({ operation: 'get', key: k('h'), propertyName: 'v' }, [{ json: {} }]);
    expect(got.outputs[0]).toEqual([{ v: { f: '1', g: '2' } }]);
    const typed = await run({ operation: 'get', key: k('set'), keyType: 'sets', propertyName: 'v' }, [{ json: {} }]);
    expect([...(typed.outputs[0]![0] as { v: string[] }).v].sort()).toEqual(["x", "y"]);
  });

  it('set with a wrong shape fails with a clear message', async () => {
    const r = await run({ operation: 'set', key: k('bad'), value: 'not json', valueType: 'hash' });
    expect(r.status).toBe('error');
    expect(String(r.error?.message ?? r.error)).toContain('JSON object');
  });

  it('set with expire sets a time to live', async () => {
    await run({ operation: 'set', key: k('ttl'), value: 'v', valueType: 'string', expire: true, ttl: 100 });
    const ttl = await direct.ttl(k('ttl'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('delete removes the key', async () => {
    await direct.set(k('d'), '1');
    const r = await run({ operation: 'delete', key: k('d') });
    expect(r.outputs[0]).toEqual([{ a: 1 }]);
    expect(await direct.exists(k('d'))).toBe(0);
  });

  it('incr counts up from zero and can expire', async () => {
    const one = await run({ operation: 'incr', key: k('c'), propertyName: 'n' }, [{ json: {} }]);
    expect(one.outputs[0]).toEqual([{ n: 1 }]);
    const two = await run(
      { operation: 'incr', key: k('c'), propertyName: 'n', expire: true, ttl: 50 },
      [{ json: {} }],
    );
    expect(two.outputs[0]).toEqual([{ n: 2 }]);
    expect(await direct.ttl(k('c'))).toBeGreaterThan(0);
  });

  it('info returns the instance fields as an object with numbers parsed', async () => {
    const r = await run({ operation: 'info' }, [{ json: {} }]);
    const info = r.outputs[0]![0] as Record<string, unknown>;
    expect(typeof info.redis_version).toBe('string');
    expect(typeof info.tcp_port).toBe('number');
  });

  it('keys returns values by default and only names with Get Values off', async () => {
    await direct.set(k('kk:1'), 'one');
    await direct.rpush(k('kk:2'), 'a', 'b');
    const withValues = await run({ operation: 'keys', keyPattern: k('kk:*') }, [{ json: {} }]);
    expect(withValues.outputs[0]).toEqual([{ [k('kk:1')]: 'one', [k('kk:2')]: ['a', 'b'] }]);
    const names = await run({ operation: 'keys', keyPattern: k('kk:*'), getValues: false }, [{ json: {} }]);
    expect([...(names.outputs[0]![0] as { keys: string[] }).keys].sort()).toEqual([k('kk:1'), k('kk:2')]);
  });

  it('push, llen and pop work from both ends and parse JSON on pop', async () => {
    const list = k('q');
    await run({ operation: 'push', list, messageData: '{"n":1}', tail: true });
    await run({ operation: 'push', list, messageData: 'plain', tail: true });
    await run({ operation: 'push', list, messageData: 'first' });
    const len = await run({ operation: 'llen', list }, [{ json: {} }]);
    expect(len.outputs[0]).toEqual([{ length: 3 }]);
    const head = await run({ operation: 'pop', list, propertyName: 'v' }, [{ json: {} }]);
    expect(head.outputs[0]).toEqual([{ v: 'first' }]);
    const tail = await run({ operation: 'pop', list, tail: true, propertyName: 'v' }, [{ json: {} }]);
    expect(tail.outputs[0]).toEqual([{ v: 'plain' }]);
    const json = await run({ operation: 'pop', list, propertyName: 'v' }, [{ json: {} }]);
    expect(json.outputs[0]).toEqual([{ v: { n: 1 } }]);
    const empty = await run({ operation: 'pop', list, propertyName: 'v' }, [{ json: {} }]);
    expect(empty.outputs[0]).toEqual([{ v: null }]);
  });

  it('publish reaches a subscriber', async () => {
    const channel = k('ch');
    const sub = new Redis({ host: creds.host, port: creds.port, db: creds.database });
    const got = new Promise<string>((resolve) => sub.on('message', (_c, m) => resolve(m)));
    await sub.subscribe(channel);
    try {
      const r = await run({ operation: 'publish', channel, messageData: 'ping' });
      expect(r.outputs[0]).toEqual([{ a: 1 }]);
      expect(await got).toBe('ping');
    } finally {
      sub.disconnect();
    }
  });

  it('runs each input item and pairs the output with it', async () => {
    const r = await run(
      { operation: 'incr', key: k('multi'), propertyName: 'n' },
      [{ json: { id: 'a' } }, { json: { id: 'b' } }],
    );
    expect(r.outputs[0]).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
    expect(r.items[0]!.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('a Redis error stops the run, or becomes an error item with continue on fail', async () => {
    await direct.set(k('str'), 'text');
    const stop = await run({ operation: 'llen', list: k('str') });
    expect(stop.status).toBe('error');
    const keep = await run({ operation: 'llen', list: k('str') }, [{ json: {} }], true);
    expect(keep.status).toBe('success');
    expect(Object.keys(keep.outputs[0]![0]!)).toEqual(['error']);
  });

  it('refuses a private-range host the guard blocks', async () => {
    const r = await runNode('app.redis', { operation: 'info' } as never, [{ json: {} }], {
      creds: { redis: { host: '169.254.169.254', port: 6379 } },
      services: { http: new HttpClient() },
    });
    expect(r.status).toBe('error');
  });
});
