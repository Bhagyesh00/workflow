/** P4-15 MQTT Trigger against an in-process aedes broker: QoS, options, ordered mode, test run, TLS, ws, guard, credential test. */
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import { createRequire } from 'node:module';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { createTriggerContext, HttpClient } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type TriggerResponse,
  type TriggerRunResult,
  Workflow,
} from '@workflow/workflow';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentials as allCredentials, nodes } from '../src';
import { connectionPlan, describeConnectError, mqttCredentialTest } from '../src/nodes/apps/mqtt/client';
import { buildItem, ORDERED_BACKLOG_LIMIT, readSettings } from '../src/nodes/apps/mqtt/MqttTrigger.node';
import { node, nodeTypes, testServices } from './harness';
import { TEST_CERT, TEST_KEY } from './imap-server';
import { localHttp } from './servers';

vi.setConfig({ hookTimeout: 60_000 });

const unique = (name: string) => `l20/${name}/${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (check: () => boolean, timeout = 10_000) =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout, interval: 25 });

let broker: Aedes;
let tcp: net.Server;
let secure: tls.Server;
let websocket: http.Server;
let tcpPort = 0;
let tlsPort = 0;
let wsPort = 0;
const USER = 'workflow';
const PASS = 'p4-secret-pass';
/** the topics the broker was asked to subscribe, as the broker saw them */
const subscribed: Array<{ topic: string; qos: number }> = [];

/** the part of `ws` the test uses: it is mqtt's own dependency, loaded through mqtt, and has no types here */
interface WsModule {
  WebSocketServer: new (options: {
    server: http.Server;
    handleProtocols(protocols: Set<string>): string | false;
  }) => { on(event: 'connection', listener: (socket: unknown) => void): void };
  createWebSocketStream(socket: unknown): NodeJS.ReadWriteStream;
}

const listen = (server: net.Server | http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  broker = await Aedes.createBroker();
  broker.authenticate = (_client, username, password, done) => {
    if (username === USER && password?.toString() === PASS) return done(null, true);
    done(Object.assign(new Error('auth'), { returnCode: 4 }) as never, false);
  };
  broker.on('subscribe', (subscriptions) => {
    for (const s of subscriptions) subscribed.push({ topic: s.topic, qos: s.qos });
  });
  tcp = net.createServer(broker.handle);
  tcpPort = await listen(tcp);
  secure = tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, broker.handle);
  tlsPort = await listen(secure);
  websocket = http.createServer();
  const requireFromMqtt = createRequire(createRequire(import.meta.url).resolve('mqtt'));
  const ws = requireFromMqtt('ws') as WsModule;
  const wss = new ws.WebSocketServer({
    server: websocket,
    handleProtocols: (protocols: Set<string>) => (protocols.has('mqtt') ? 'mqtt' : false),
  });
  wss.on('connection', (socket) => broker.handle(ws.createWebSocketStream(socket) as never));
  wsPort = await listen(websocket);
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  tcp.close();
  secure.close();
  websocket.close();
});

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

const creds = (overrides: DataObject = {}): DataObject => ({
  protocol: 'mqtt',
  host: '127.0.0.1',
  port: tcpPort,
  username: USER,
  password: PASS,
  ...overrides,
});

/** a client of the test that publishes */
async function publisher(): Promise<MqttClient> {
  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
    username: USER,
    password: PASS,
    clientId: `pub-${randomUUID().slice(0, 8)}`,
  });
  closers.push(() => client.endAsync(true));
  return client;
}

interface Run {
  items: Item[];
  done?: { resolve(r: TriggerRunResult): void; reject(e: Error): void };
}

interface Options {
  creds?: DataObject;
  http?: HttpClient;
  mode?: 'activate' | 'manual';
  /** answer each run; without it the run is answered at once */
  onRun?: (run: Run, index: number) => void;
}

function harness(parameters: DataObject, options: Options = {}) {
  const logs: string[] = [];
  const record = (message: unknown) => void logs.push(String(message));
  const wfNode = node('MQTT Trigger', 'app.mqttTrigger', parameters, [0, 0], {
    credentials: { mqtt: { id: 'mqtt', name: 'mqtt' } },
  });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: {} },
    nodeTypes,
  );
  const runs: Run[] = [];
  const errors: Error[] = [];
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices(
        { mqtt: options.creds ?? creds() },
        {
          mode: options.mode === 'manual' ? 'manual' : 'trigger',
          http: options.http ?? localHttp(),
          logger: { debug: record, info: record, warn: record, error: record } as never,
        },
      ),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      activationMode: options.mode ?? 'activate',
      emit: (data, done) => {
        const run: Run = { items: data[0] ?? [], done };
        runs.push(run);
        if (options.onRun) options.onRun(run, runs.length - 1);
        else done?.resolve({ executionId: `run-${runs.length}`, status: 'success' });
      },
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, runs, errors, logs };
}

const nodeType = () => nodes.find((n) => n.description.name === 'app.mqttTrigger')!;

async function start(parameters: DataObject, options: Options = {}) {
  const h = harness(parameters, options);
  const response = (await nodeType().trigger!(h.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...h, response };
}

const topics = (...rows: Array<[string, number?]>) => ({
  topicsUi: { topicsValues: rows.map(([topic, qos]) => ({ topic, qos: qos ?? 0 })) },
});

describe('node and credential', () => {
  it('has the final name, a topics field, the options of n8n and a credential test', () => {
    const type = nodeType();
    expect(type.description.displayName).toBe('MQTT Trigger');
    expect(type.description.properties.map((p) => p.name)).toEqual(['topicsUi', 'options']);
    const options = type.description.properties.find((p) => p.name === 'options')!;
    expect((options.options as Array<{ name: string }>).map((o) => o.name)).toEqual([
      'jsonParseBody',
      'onlyMessage',
      'parallelProcessing',
    ]);
    expect(type.description.credentials?.[0]).toMatchObject({ name: 'mqtt', testedBy: 'mqttCredentialTest' });
    expect(type.methods?.credentialTest?.mqttCredentialTest).toBe(mqttCredentialTest);
  });

  it('the credential has the fields of n8n, hides secrets, verifies certificates by default', () => {
    const credential = allCredentials.find((c) => c.name === 'mqtt')!;
    expect(credential.hideDomainRestrictionFields).toBe(true);
    expect(credential.properties.map((p) => p.name)).toEqual([
      'protocol',
      'host',
      'port',
      'username',
      'password',
      'clean',
      'clientId',
      'ssl',
      'passwordless',
      'ca',
      'rejectUnauthorized',
      'cert',
      'key',
    ]);
    const field = (name: string) => credential.properties.find((p) => p.name === name)!;
    expect(field('rejectUnauthorized').default).toBe(true);
    expect(field('protocol').default).toBe('mqtt');
    expect(field('port').default).toBe(1883);
    for (const name of ['password', 'ca', 'cert', 'key']) {
      expect(field(name).typeOptions?.password).toBe(true);
    }
  });
});

describe('settings and item', () => {
  const settingsFor = (parameters: DataObject) =>
    readSettings({
      getNodeParameter: (name: string, _i: number, fallback?: unknown) => parameters[name] ?? fallback,
    } as never);

  it('reads topics with their QoS and the defaults of the options', () => {
    expect(settingsFor(topics(['a', 1], ['b', 2]))).toEqual({
      topics: [
        { topic: 'a', qos: 1 },
        { topic: 'b', qos: 2 },
      ],
      jsonParseBody: false,
      onlyMessage: false,
      parallelProcessing: true,
    });
  });

  it('refuses no topic and a QoS outside 0 to 2', () => {
    expect(() => settingsFor(topics(['', 0]))).toThrow('Add at least one topic');
    expect(() => settingsFor(topics(['a', 3]))).toThrow('QoS');
  });

  it('builds the item: text by default, parsed with JSON Parse Body, wrapped when Only Message has a text', () => {
    const warn = vi.fn();
    const opts = { jsonParseBody: false, onlyMessage: false };
    expect(buildItem('t', Buffer.from('{"a":1}'), opts, warn).json).toEqual({
      topic: 't',
      message: '{"a":1}',
    });
    expect(buildItem('t', Buffer.from('{"a":1}'), { ...opts, jsonParseBody: true }, warn).json).toEqual({
      topic: 't',
      message: { a: 1 },
    });
    expect(
      buildItem('t', Buffer.from('{"a":1}'), { jsonParseBody: true, onlyMessage: true }, warn).json,
    ).toEqual({ a: 1 });
    expect(buildItem('t', Buffer.from('hi'), { jsonParseBody: false, onlyMessage: true }, warn).json).toEqual(
      { message: 'hi' },
    );
    expect(warn).not.toHaveBeenCalled();
    expect(buildItem('t', Buffer.from('nope'), { ...opts, jsonParseBody: true }, warn).json).toEqual({
      topic: 't',
      message: 'nope',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('plans the transport and keeps verification on unless the credential turns it off', () => {
    expect(connectionPlan({ host: 'h' })).toMatchObject({ transport: 'mqtt', port: 1883 });
    expect(connectionPlan({ host: 'h', protocol: 'mqtts', port: '' })).toMatchObject({
      transport: 'mqtts',
      port: 8883,
    });
    expect(connectionPlan({ host: 'h', protocol: 'ws', ssl: true })).toMatchObject({
      transport: 'wss',
      port: 443,
    });
    expect(connectionPlan({ host: 'h', ssl: true }).tls.rejectUnauthorized).toBe(true);
    expect(connectionPlan({ host: 'h', ssl: true, rejectUnauthorized: false }).tls.rejectUnauthorized).toBe(
      false,
    );
    expect(connectionPlan({ host: 'h', username: 'u' }).options.username).toBeUndefined();
    expect(() => connectionPlan({ host: '' })).toThrow('Enter the MQTT host');
    expect(() => connectionPlan({ host: 'h', port: 70000 })).toThrow('port');
    expect(() => connectionPlan({ host: 'h', ssl: true, cert: 'x' })).toThrow('both');
  });

  it('describes connect errors with fixed texts', () => {
    expect(describeConnectError({ code: 4 })).toBe('MQTT refused the username or password');
    expect(describeConnectError({ code: 'ECONNREFUSED' })).toBe("Couldn't connect to MQTT (ECONNREFUSED)");
    expect(describeConnectError(new Error('secret words'))).toBe("Couldn't connect to MQTT");
  });
});

describe('subscribing and messages', () => {
  it('subscribes every topic with its own QoS and starts one run per message', async () => {
    const a = unique('a');
    const b = unique('b');
    subscribed.length = 0;
    const t = await start(topics([a, 1], [b, 2]));
    expect(subscribed).toEqual(
      expect.arrayContaining([
        { topic: a, qos: 1 },
        { topic: b, qos: 2 },
      ]),
    );
    const pub = await publisher();
    await pub.publishAsync(a, 'one', { qos: 1 });
    await pub.publishAsync(b, 'two', { qos: 2 });
    await until(() => t.runs.length === 2);
    const bodies = t.runs.map((r) => r.items[0].json);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { topic: a, message: 'one' },
        { topic: b, message: 'two' },
      ]),
    );
  });

  it('matches wildcards', async () => {
    const root = unique('wild');
    const t = await start(topics([`${root}/+/temp`], [`${root}/all/#`]));
    const pub = await publisher();
    await pub.publishAsync(`${root}/kitchen/temp`, '21');
    await pub.publishAsync(`${root}/all/deep/er`, 'x');
    await until(() => t.runs.length === 2);
    expect(t.runs.map((r) => r.items[0].json.topic).sort()).toEqual([
      `${root}/all/deep/er`,
      `${root}/kitchen/temp`,
    ]);
  });

  it('JSON Parse Body and Only Message', async () => {
    const topic = unique('json');
    const t = await start({ ...topics([topic]), options: { jsonParseBody: true, onlyMessage: true } });
    const pub = await publisher();
    await pub.publishAsync(topic, '{"temp":21,"unit":"C"}');
    await pub.publishAsync(topic, 'plain text');
    await until(() => t.runs.length === 2);
    expect(t.runs[0].items[0].json).toEqual({ temp: 21, unit: 'C' });
    expect(t.runs[1].items[0].json).toEqual({ message: 'plain text' });
    expect(t.logs.some((l) => l.includes('Could not parse'))).toBe(true);
  });

  it('delivers a retained message when the trigger subscribes', async () => {
    const topic = unique('retained');
    const pub = await publisher();
    await pub.publishAsync(topic, 'kept', { qos: 1, retain: true });
    const t = await start(topics([topic]));
    await until(() => t.runs.length === 1);
    expect(t.runs[0].items[0].json).toEqual({ topic, message: 'kept' });
    await pub.publishAsync(topic, '', { qos: 1, retain: true });
  });

  /** a session the broker keeps, with one message that waits for it */
  async function sessionWithWaitingMessage(topic: string) {
    const clientId = `sess-${randomUUID().slice(0, 8)}`;
    const session = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      username: USER,
      password: PASS,
      clientId,
      clean: false,
    });
    await session.subscribeAsync(topic, { qos: 1 });
    await session.endAsync();
    const pub = await publisher();
    await pub.publishAsync(topic, 'while away', { qos: 1 });
    return creds({ clientId, clean: false });
  }

  it('a resumed session gets the messages that waited while it was away', async () => {
    const topic = unique('offline');
    const resumed = await sessionWithWaitingMessage(topic);
    const t = await start(topics([topic, 1]), { creds: resumed });
    await until(() => t.runs.length === 1, 3000);
    expect(t.runs[0].items[0].json).toEqual({ topic, message: 'while away' });
  });

  it('a test run keeps the message of a resumed session until it starts waiting', async () => {
    const topic = unique('offline-manual');
    const resumed = await sessionWithWaitingMessage(topic);
    const t = await start(topics([topic, 1]), { creds: resumed, mode: 'manual' });
    await sleep(300);
    expect(t.runs).toHaveLength(0);
    await t.response.manualTriggerFunction!();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0].items[0].json).toEqual({ topic, message: 'while away' });
  });

  it('parallel processing starts runs without waiting for the one before', async () => {
    const topic = unique('par');
    const t = await start(topics([topic]), { onRun: () => undefined });
    const pub = await publisher();
    for (const n of ['1', '2', '3']) await pub.publishAsync(topic, n, { qos: 1 });
    await until(() => t.runs.length === 3);
  });

  it('ordered mode starts the next run only after the one before has finished', async () => {
    const topic = unique('ordered');
    const t = await start(
      { ...topics([topic]), options: { parallelProcessing: false } },
      { onRun: () => undefined },
    );
    const pub = await publisher();
    for (const n of ['1', '2', '3']) await pub.publishAsync(topic, n, { qos: 1 });
    await until(() => t.runs.length === 1);
    await sleep(300);
    expect(t.runs).toHaveLength(1);
    t.runs[0].done!.resolve({ executionId: 'e1', status: 'success' });
    await until(() => t.runs.length === 2);
    await sleep(200);
    expect(t.runs).toHaveLength(2);
    // a failed run also frees the queue
    t.runs[1].done!.reject(new Error('run failed'));
    await until(() => t.runs.length === 3);
    expect(t.runs.map((r) => r.items[0].json.message)).toEqual(['1', '2', '3']);
    expect(ORDERED_BACKLOG_LIMIT).toBeGreaterThan(0);
  });

  it('closing stops the messages', async () => {
    const topic = unique('close');
    const t = await start(topics([topic]));
    await t.response.closeFunction!();
    const pub = await publisher();
    await pub.publishAsync(topic, 'late', { qos: 1 });
    await sleep(200);
    expect(t.runs).toHaveLength(0);
    expect(t.errors).toHaveLength(0);
  });

  it('reports a lost connection once through emitError', async () => {
    const topic = unique('lost');
    const clientId = `lost-${randomUUID().slice(0, 8)}`;
    const t = await start(topics([topic]), { creds: creds({ clientId }) });
    // the broker drops it when another connection takes the client ID
    const thief = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, {
      username: USER,
      password: PASS,
      clientId,
    });
    closers.push(() => thief.endAsync(true));
    await until(() => t.errors.length > 0);
    await sleep(100);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0].message).toBe('The MQTT connection closed unexpectedly');
  });

  it('fails the start with a fixed text on a wrong password, without echoing it', async () => {
    const h = harness(topics([unique('bad')]), { creds: creds({ password: 'wrong-secret-xyz' }) });
    const error = await nodeType().trigger!(h.ctx).catch((e: Error) => e);
    expect((error as Error).message).toBe('MQTT refused the username or password');
    expect((error as Error).message).not.toContain('wrong-secret-xyz');
  });

  it('fails the start when a topic is refused', async () => {
    const old = broker.authorizeSubscribe;
    broker.authorizeSubscribe = (_client, sub, done) =>
      sub.topic.startsWith('denied/') ? done(null, null) : done(null, sub);
    try {
      const h = harness(topics(['denied/x']));
      await expect(nodeType().trigger!(h.ctx)).rejects.toThrow("Couldn't subscribe");
    } finally {
      broker.authorizeSubscribe = old;
    }
  });
});

describe('test run', () => {
  it('takes the first message, starts one run and ignores the rest', async () => {
    const topic = unique('manual');
    const t = await start(topics([topic]), { mode: 'manual' });
    const waiting = t.response.manualTriggerFunction!();
    const pub = await publisher();
    await pub.publishAsync(topic, 'first', { qos: 1 });
    await pub.publishAsync(topic, 'second', { qos: 1 });
    await waiting;
    await sleep(200);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0].items[0].json).toEqual({ topic, message: 'first' });
  });
});

describe('transports', () => {
  it('connects over TLS with the CA of the credential and verifies it', async () => {
    const topic = unique('tls');
    const t = await start(topics([topic]), {
      creds: creds({ protocol: 'mqtts', port: tlsPort, ssl: true, ca: TEST_CERT }),
    });
    const pub = await publisher();
    await pub.publishAsync(topic, 'secure', { qos: 1 });
    await until(() => t.runs.length === 1);
    expect(t.runs[0].items[0].json.message).toBe('secure');
  });

  it('refuses a certificate it cannot verify (Reject Unauthorized is on by default) and accepts it when turned off', async () => {
    const withoutCa = creds({ protocol: 'mqtts', port: tlsPort });
    const r = await mqttCredentialTest(testCtx(), { type: 'mqtt', data: withoutCa });
    expect(r.message).toMatch(/^Couldn't connect to MQTT/);
    const off = await mqttCredentialTest(testCtx(), {
      type: 'mqtt',
      data: { ...withoutCa, ssl: true, rejectUnauthorized: false },
    });
    expect(off).toEqual({ status: 'OK', message: 'Connection successful' });
  });

  it('connects over a WebSocket', async () => {
    const topic = unique('ws');
    const t = await start(topics([topic]), { creds: creds({ protocol: 'ws', port: wsPort }) });
    const pub = await publisher();
    await pub.publishAsync(topic, 'over ws', { qos: 1 });
    await until(() => t.runs.length === 1);
    expect(t.runs[0].items[0].json.message).toBe('over ws');
  });
});

describe('SSRF guard', () => {
  it('refuses loopback and private hosts with the default client', async () => {
    for (const protocol of ['mqtt', 'ws']) {
      for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254']) {
        const h = harness(topics([unique('g')]), {
          creds: creds({ protocol, host }),
          http: new HttpClient(),
        });
        await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(/blocked/);
      }
    }
  });

  for (const [label, protocol, port] of [
    ['tcp', 'mqtt', () => tcpPort],
    ['ws', 'ws', () => wsPort],
  ] as const) {
    it(`connects only to the address the check passed (DNS rebind, ${label})`, async () => {
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
      try {
        const h = harness(topics([unique('rb')]), { creds: creds({ protocol, host: REBIND, port: port() }) });
        await expect(
          Promise.race([
            nodeType().trigger!(h.ctx),
            new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 3000)),
          ]),
        ).rejects.toBeDefined();
        expect(lookup.mock.calls.some(([host]) => host === REBIND)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    });
  }
});

function testCtx() {
  const client = localHttp();
  return {
    helpers: {
      resolveAllowedHost: (h: string) => client.resolveAllowedHost(h),
      assertHostAllowed: async () => undefined,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    getTenantId: () => 't1',
  } as never;
}

describe('credential test', () => {
  it('passes against the broker', async () => {
    expect(await mqttCredentialTest(testCtx(), { type: 'mqtt', data: creds() })).toEqual({
      status: 'OK',
      message: 'Connection successful',
    });
  });

  it('fails clearly on a wrong password, without echoing it', async () => {
    const r = await mqttCredentialTest(testCtx(), {
      type: 'mqtt',
      data: creds({ password: 'wrong-secret-xyz' }),
    });
    expect(r).toEqual({ status: 'Error', message: 'MQTT refused the username or password' });
  });

  it('fails clearly when nothing listens', async () => {
    const r = await mqttCredentialTest(testCtx(), { type: 'mqtt', data: creds({ port: 1 }) });
    expect(r.status).toBe('Error');
    expect(r.message).toMatch(/^Couldn't connect to MQTT/);
  });
});
