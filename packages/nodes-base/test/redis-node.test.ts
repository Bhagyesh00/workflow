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
const creds = {
  host: url.hostname,
  port: Number(url.port || 6379),
  database: Number(url.pathname.slice(1) || 0),
};
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

const run = (
  parameters: Record<string, unknown>,
  input: Array<{ json: DataObject }> = [{ json: { a: 1 } }],
  continueOnFail = false,
) =>
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
    expect(values.sort()).toEqual([
      'delete',
      'get',
      'incr',
      'info',
      'keys',
      'llen',
      'pop',
      'publish',
      'push',
      'set',
    ]);
    for (const o of operation.options as Array<{ action?: string }>) expect(o.action).toBeTruthy();
  });

  it('set then get a string; set keeps the input item and get starts from an empty one', async () => {
    const set = await run({ operation: 'set', key: k('s'), value: 'hello', valueType: 'string' });
    expect(set.status).toBe('success');
    expect(set.outputs[0]).toEqual([{ a: 1 }]);
    expect(await direct.get(k('s'))).toBe('hello');
    const got = await run({ operation: 'get', key: k('s'), propertyName: 'v' });
    // like n8n, the output item holds only the value
    expect(got.outputs[0]).toEqual([{ v: 'hello' }]);
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
    await run({ operation: 'set', key: k('auto'), value: 'plain text' });
    expect(await direct.type(k('auto'))).toBe('string');
    const got = await run({ operation: 'get', key: k('h'), propertyName: 'v' }, [{ json: {} }]);
    expect(got.outputs[0]).toEqual([{ v: { f: '1', g: '2' } }]);
    const typed = await run({ operation: 'get', key: k('set'), keyType: 'sets', propertyName: 'v' }, [
      { json: {} },
    ]);
    expect([...(typed.outputs[0]![0] as { v: string[] }).v].sort()).toEqual(['x', 'y']);
  });

  it('Automatic keeps JSON text a string key and a later plain Set overwrites it', async () => {
    await run({ operation: 'set', key: k('jtext'), value: '{"a":1}' });
    expect(await direct.type(k('jtext'))).toBe('string');
    expect(await direct.get(k('jtext'))).toBe('{"a":1}');
    await run({ operation: 'set', key: k('jarr'), value: '[1,2]' });
    await run({ operation: 'set', key: k('jarr'), value: '[1,2]' });
    expect(await direct.type(k('jarr'))).toBe('string');
    await run({ operation: 'set', key: k('jtext'), value: 'now plain' });
    expect(await direct.get(k('jtext'))).toBe('now plain');
  });

  it('Automatic stores an array as a list and an object as a hash when the value is not text', async () => {
    await run({ operation: 'set', key: k('aarr'), value: ['a', 'b'] });
    expect(await direct.type(k('aarr'))).toBe('list');
    expect(await direct.lrange(k('aarr'), 0, -1)).toEqual(['a', 'b']);
    await run({ operation: 'set', key: k('aobj'), value: { q: 1 } });
    expect(await direct.type(k('aobj'))).toBe('hash');
    expect(await direct.hgetall(k('aobj'))).toEqual({ q: '1' });
  });

  it('Value Is JSON is on by default and only shows for the Hash type', () => {
    const type = nodes.find((n) => n.description.name === 'app.redis')!;
    const prop = type.description.properties.find((p) => p.name === 'valueIsJSON')!;
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(true);
    expect(prop.displayOptions).toEqual({ show: { operation: ['set'], valueType: ['hash'] } });
  });

  it('a Hash with Value Is JSON off reads field and value pairs separated by spaces', async () => {
    const ok = await run({
      operation: 'set',
      key: k('pairs'),
      value: 'f1 v1  f2 {"x":1}',
      valueType: 'hash',
      valueIsJSON: false,
    });
    expect(ok.status).toBe('success');
    expect(await direct.hgetall(k('pairs'))).toEqual({ f1: 'v1', f2: '{"x":1}' });
    const odd = await run({
      operation: 'set',
      key: k('pairs2'),
      value: 'f1 v1 f2',
      valueType: 'hash',
      valueIsJSON: false,
    });
    expect(odd.status).toBe('error');
    expect(await direct.exists(k('pairs2'))).toBe(0);
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
    // like n8n, the one property is named after the key
    const one = await run({ operation: 'incr', key: k('c') }, [{ json: {} }]);
    expect(one.outputs[0]).toEqual([{ [k('c')]: 1 }]);
    const two = await run({ operation: 'incr', key: k('c'), expire: true, ttl: 50 }, [{ json: {} }]);
    expect(two.outputs[0]).toEqual([{ [k('c')]: 2 }]);
    expect(await direct.ttl(k('c'))).toBeGreaterThan(0);
  });

  it('a TTL of 0 or less does not delete the key (incr and set)', async () => {
    await run({ operation: 'incr', key: k('z'), expire: true, ttl: 0 }, [{ json: {} }]);
    expect(await direct.get(k('z'))).toBe('1');
    await run({ operation: 'set', key: k('z2'), value: 'v', valueType: 'string', expire: true, ttl: -5 });
    expect(await direct.get(k('z2'))).toBe('v');
  });

  it('info returns the instance fields as an object with numbers parsed', async () => {
    const r = await run({ operation: 'info' }, [{ json: {} }]);
    const info = r.outputs[0]![0] as Record<string, unknown>;
    expect(typeof info.redis_version).toBe('string');
    expect(typeof info.tcp_port).toBe('number');
  });

  it('info runs once however many items come in', async () => {
    const r = await run({ operation: 'info' }, [{ json: { i: 1 } }, { json: { i: 2 } }, { json: { i: 3 } }]);
    expect(r.outputs[0]).toHaveLength(1);
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
    expect(len.outputs[0]).toEqual([{ [list]: 3 }]);
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
    const r = await run({ operation: 'incr', key: k('multi') }, [
      { json: { id: 'a' } },
      { json: { id: 'b' } },
    ]);
    expect(r.outputs[0]).toEqual([{ [k('multi')]: 1 }, { [k('multi')]: 2 }]);
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
