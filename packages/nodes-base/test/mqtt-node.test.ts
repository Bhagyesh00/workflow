/** P4-27 MQTT node against an in-process aedes broker: publish, QoS, retain, send input data, errors. */
import { randomUUID } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { runNode } from './harness';
import { localHttp } from './servers';

vi.setConfig({ hookTimeout: 60_000 });

const unique = (name: string) => `l20n/${name}/${randomUUID().slice(0, 8)}`;
const USER = 'workflow';
const PASS = 'p4-secret-pass';
let broker: Aedes;
let server: net.Server;
let port = 0;
const published: Array<{ topic: string; payload: string; qos: number; retain: boolean }> = [];

beforeAll(async () => {
  broker = await Aedes.createBroker();
  broker.authenticate = (_c, username, password, done) => {
    if (username === USER && password?.toString() === PASS) return done(null, true);
    done(Object.assign(new Error('auth'), { returnCode: 4 }) as never, false);
  };
  broker.on('publish', (packet) => {
    if (packet.topic.startsWith('l20n/'))
      published.push({ topic: packet.topic, payload: packet.payload.toString(), qos: packet.qos, retain: packet.retain });
  });
  server = net.createServer(broker.handle);
  port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
});
afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  server.close();
});

const clients: MqttClient[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.endAsync(true)));
});

const creds = (extra: Record<string, unknown> = {}) => ({
  mqtt: { protocol: 'mqtt', host: '127.0.0.1', port, username: USER, password: PASS, ...extra },
});
const run = (parameters: Record<string, unknown>, input: unknown[] = [{ json: { a: 1 } }], c = creds()) =>
  runNode('app.mqtt', parameters as never, input as never, { creds: c, services: { http: localHttp() } });

describe('description', () => {
  it('has a publish operation with an action and a credential test', () => {
    const type = nodes.find((n) => n.description.name === 'app.mqtt')!;
    expect(type.description.credentials?.[0]).toMatchObject({ name: 'mqtt', testedBy: 'mqttCredentialTest' });
    const names = type.description.properties.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['topic', 'sendInputData', 'message', 'options']));
  });
});

describe('publish', () => {
  it('sends the input item as JSON and passes the items on', async () => {
    const topic = unique('input');
    const r = await run({ topic, sendInputData: true }, [{ json: { a: 1 } }, { json: { b: 2 } }]);
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ a: 1 }, { b: 2 }]);
    const got = published.filter((p) => p.topic === topic).map((p) => JSON.parse(p.payload));
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('sends the message text with QoS and retain', async () => {
    const topic = unique('text');
    const r = await run({ topic, sendInputData: false, message: 'hello', options: { qos: 1, retain: true } });
    expect(r.status).toBe('success');
    expect(published.find((p) => p.topic === topic)).toMatchObject({ payload: 'hello', qos: 1, retain: true });
  });

  it('a retained message reaches a later subscriber', async () => {
    const topic = unique('retain');
    await run({ topic, sendInputData: false, message: 'kept', options: { retain: true } });
    const sub = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { username: USER, password: PASS });
    clients.push(sub);
    const message = new Promise<string>((resolve) => sub.on('message', (_t, p) => resolve(p.toString())));
    await sub.subscribeAsync(topic);
    expect(await message).toBe('kept');
  });

  it('reads topic and message per item', async () => {
    const t1 = unique('x1');
    const t2 = unique('x2');
    const r = await run({ topic: '={{ $json.t }}', sendInputData: false, message: '={{ $json.m }}' }, [
      { json: { t: t1, m: 'one' } },
      { json: { t: t2, m: 'two' } },
    ]);
    expect(r.status).toBe('success');
    expect(published.find((p) => p.topic === t1)?.payload).toBe('one');
    expect(published.find((p) => p.topic === t2)?.payload).toBe('two');
  });

  it('rejects an empty topic and a bad QoS', async () => {
    const a = await run({ topic: '', sendInputData: true });
    expect(a.status).toBe('error');
    const b = await run({ topic: unique('q'), sendInputData: true, options: { qos: 7 } });
    expect(b.status).toBe('error');
  });
});

describe('errors', () => {
  it('a wrong password gives a fixed text without the password', async () => {
    const r = await run({ topic: unique('bad'), sendInputData: true }, [{ json: {} }], creds({ password: 'nope-secret' }));
    expect(r.status).toBe('error');
    const text = String(r.error?.message ?? JSON.stringify(r.error));
    expect(text).toMatch(/username or password/);
    expect(text).not.toContain('nope-secret');
  });

  it('continue on fail keeps the item with an error', async () => {
    const r = await run({ topic: unique('c'), sendInputData: true }, [{ json: { a: 1 } }], creds({ password: 'nope' }));
    expect(r.status).toBe('error');
    const ok = await runNode('app.mqtt', { topic: unique('c'), sendInputData: true } as never, [{ json: { a: 1 } }] as never, {
      creds: creds({ password: 'nope' }),
      services: { http: localHttp() },
      node: { onError: 'continueRegularOutput' } as never,
    });
    expect(ok.outputs[0]?.[0]).toHaveProperty('error');
  });

  it('refuses a private host through the guard', async () => {
    const r = await runNode('app.mqtt', { topic: 't', sendInputData: true } as never, [{ json: {} }] as never, {
      creds: creds({ host: '10.0.0.5' }),
    });
    expect(r.status).toBe('error');
  });
});
