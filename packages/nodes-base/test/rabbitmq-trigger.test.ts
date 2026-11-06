/**
 * RabbitMQ Trigger against the real test broker (TEST_RABBITMQ_URL), plus the tracker on a fake channel
 * for what a broker cannot be made to do on demand.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createTriggerContext, HttpClient } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type TriggerResponse,
  type TriggerRunResult,
  type WebhookResponse,
  Workflow,
} from '@workflow/workflow';
import { type Channel, type ChannelModel, type ConsumeMessage, connect } from 'amqplib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentials as allCredentials, nodes } from '../src';
import {
  connectionSettings,
  describeConnectError,
  describeSetupError,
  rabbitmqCredentialTest,
} from '../src/nodes/apps/rabbitmq/connect';
import {
  createMessageParser,
  createTracker,
  PARALLEL_LIMIT_ERROR,
  readTriggerSettings,
} from '../src/nodes/apps/rabbitmq/tracker';
import { node, nodeTypes, testServices } from './harness';
import { localHttp } from './servers';

vi.setConfig({ hookTimeout: 60_000 });

const URL_TEXT = process.env.TEST_RABBITMQ_URL ?? 'amqp://workflow:workflow@127.0.0.1:5672';
const BROKER = new URL(URL_TEXT);
const PORT = Number(BROKER.port || 5672);
const brokerCredentials = (overrides: DataObject = {}) => ({
  hostname: BROKER.hostname,
  port: PORT,
  username: decodeURIComponent(BROKER.username),
  password: decodeURIComponent(BROKER.password),
  vhost: '/',
  ssl: false,
  ...overrides,
});

const unique = (name: string) => `l19-${name}-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** the tracker parses before it emits */
const tick = () => sleep(20);
const until = (check: () => boolean | Promise<boolean>, timeout = 20_000) =>
  vi.waitFor(
    async () => {
      expect(await check()).toBe(true);
    },
    { timeout, interval: 50 },
  );

let side: ChannelModel;
let sideChannel: Channel;
const closers: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  side = await connect(URL_TEXT);
  sideChannel = await side.createChannel();
});

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

afterAll(async () => {
  await sideChannel.close();
  await side.close();
});

/** a queue of its own, removed after the test */
async function newQueue(name: string, args: Record<string, unknown> = {}) {
  const queue = unique(name);
  await sideChannel.assertQueue(queue, { durable: true, arguments: args });
  closers.push(() => sideChannel.deleteQueue(queue).catch(() => undefined));
  return queue;
}

const publish = (queue: string, body: string | Buffer, options: Record<string, unknown> = {}) =>
  sideChannel.sendToQueue(queue, Buffer.isBuffer(body) ? body : Buffer.from(body), options);

const depth = async (queue: string) => (await sideChannel.checkQueue(queue)).messageCount;

interface EmittedRun {
  items: Item[];
  done?: { resolve(r: TriggerRunResult): void; reject(e: Error): void };
  hook?: (r: WebhookResponse) => void;
}

interface HarnessOptions {
  creds?: DataObject;
  httpClient?: HttpClient;
  mode?: 'activate' | 'manual';
  /** answer each run; without it runs are answered with `success` */
  onRun?: (run: EmittedRun, index: number) => void;
}

function harness(parameters: DataObject, options: HarnessOptions = {}) {
  const creds = { rabbitmq: options.creds ?? brokerCredentials() };
  const logs: string[] = [];
  const record = (message: unknown) => void logs.push(String(message));
  const logger = { debug: record, info: record, warn: record, error: record };
  const wfNode = node('RabbitMQ Trigger', 'app.rabbitmqTrigger', parameters, [0, 0], {
    credentials: { rabbitmq: { id: 'rabbitmq', name: 'rabbitmq' } },
  });
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: [wfNode], connections: {}, staticData: {} },
    nodeTypes,
  );
  const runs: EmittedRun[] = [];
  const errors: Error[] = [];
  const ctx = createTriggerContext(
    {
      workflow,
      node: wfNode,
      services: testServices(creds, {
        mode: options.mode === 'manual' ? 'manual' : 'trigger',
        http: options.httpClient ?? localHttp(),
        logger: logger as never,
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      activationMode: options.mode ?? 'activate',
      emit: (data, done, hook) => {
        const run: EmittedRun = { items: data[0] ?? [], done, hook };
        runs.push(run);
        if (options.onRun) options.onRun(run, runs.length - 1);
        else done?.resolve({ executionId: `run-${runs.length}`, status: 'success' });
      },
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, runs, errors, logs };
}

const nodeType = () => nodes.find((n) => n.description.name === 'app.rabbitmqTrigger')!;

async function start(parameters: DataObject, options: HarnessOptions = {}) {
  const h = harness(parameters, options);
  const response = (await nodeType().trigger!(h.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...h, response };
}

describe('node and credential', () => {
  it('has the final name, a queue field, the options of n8n and a credential test', () => {
    const type = nodeType();
    expect(type.description.displayName).toBe('RabbitMQ Trigger');
    expect(type.description.properties.map((p) => p.name)).toEqual(['queue', 'options']);
    const options = type.description.properties.find((p) => p.name === 'options')!;
    const names = (options.options as Array<{ name: string }>).map((o) => o.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'acknowledge',
        'arguments',
        'assertExchange',
        'assertQueue',
        'autoDelete',
        'binding',
        'contentIsBinary',
        'durable',
        'exclusive',
        'headers',
        'jsonParseBody',
        'onlyContent',
        'parallelMessages',
      ]),
    );
    const acknowledge = (options.options as Array<{ name: string; options?: Array<{ value: string }> }>).find(
      (o) => o.name === 'acknowledge',
    )!;
    expect(acknowledge.options!.map((o) => o.value)).toEqual([
      'executionFinishes',
      'executionFinishesSuccessfully',
      'immediately',
      'laterMessageNode',
    ]);
    expect(type.description.credentials?.[0]).toMatchObject({
      name: 'rabbitmq',
      testedBy: 'rabbitmqCredentialTest',
    });
    expect(type.methods?.credentialTest?.rabbitmqCredentialTest).toBe(rabbitmqCredentialTest);
  });

  it('the credential has the fields of n8n, hides secrets and asks for no HTTP domains', () => {
    const credential = allCredentials.find((c) => c.name === 'rabbitmq')!;
    expect(credential.hideDomainRestrictionFields).toBe(true);
    const names = credential.properties.map((p) => p.name);
    expect(names).toEqual([
      'hostname',
      'port',
      'username',
      'password',
      'vhost',
      'ssl',
      'passwordless',
      'ca',
      'cert',
      'key',
      'passphrase',
    ]);
    const secret = (name: string) =>
      credential.properties.find((p) => p.name === name)!.typeOptions?.password === true;
    expect(['password', 'ca', 'cert', 'key', 'passphrase'].every(secret)).toBe(true);
    expect(credential.properties.find((p) => p.name === 'port')!.default).toBe(5672);
    expect(credential.properties.find((p) => p.name === 'vhost')!.default).toBe('/');
  });

  it('builds the connection from the credential and refuses unusable fields', () => {
    const plain = connectionSettings(brokerCredentials({ hostname: ' [::1] ', port: '5673' }));
    expect(plain.url).toMatchObject({ protocol: 'amqp', hostname: '::1', port: 5673, vhost: '/' });
    expect(plain.socketOptions.credentials).toBeUndefined();
    expect(() => connectionSettings(brokerCredentials({ hostname: '' }))).toThrow(/hostname/);
    expect(() => connectionSettings(brokerCredentials({ port: 70000 }))).toThrow(/port/);
    expect(() => connectionSettings(brokerCredentials({ ssl: true, cert: 'x', key: '' }))).toThrow(
      /both a certificate and a key/,
    );
    expect(() => connectionSettings(brokerCredentials({ ssl: true, passwordless: true }))).toThrow(
      /Passwordless sign-in needs/,
    );
    const tlsWithPassword = connectionSettings(brokerCredentials({ ssl: true, passwordless: false }));
    expect(tlsWithPassword.url.protocol).toBe('amqps');
    expect(tlsWithPassword.url.username).toBe('workflow');
    expect(tlsWithPassword.socketOptions.rejectUnauthorized).toBeUndefined();
  });

  it('says what went wrong in its own words', () => {
    expect(describeConnectError(new Error('Handshake terminated: 403 (ACCESS-REFUSED) user "bob"'))).toBe(
      'RabbitMQ refused the username or password',
    );
    expect(describeConnectError(new Error('530 (NOT-ALLOWED) vhost secret-host not found'))).toBe(
      'RabbitMQ refused access to the virtual host',
    );
    expect(describeConnectError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      "Couldn't connect to RabbitMQ (ECONNREFUSED)",
    );
    expect(describeConnectError(new Error('anything with password=hunter2'))).toBe(
      "Couldn't connect to RabbitMQ",
    );
  });
});

describe('queue setup errors', () => {
  it('a transient queue is explained, and an unknown refusal is cut to its first line', async () => {
    const h = harness({ queue: unique('transient'), options: { durable: false } });
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(/neither durable nor exclusive/);
    expect(describeSetupError(new Error('PRECONDITION_FAILED - x\nsecond line'))).toBe(
      'PRECONDITION_FAILED - x',
    );
  });
});

describe('settings', () => {
  const settingsOf = (options: DataObject, queue = 'q', mode: 'activate' | 'manual' = 'activate') =>
    readTriggerSettings(harness({ queue, options }, { mode }).ctx);

  it('defaults to acknowledging at once without a limit', () => {
    const settings = settingsOf({});
    expect(settings).toMatchObject({
      queue: 'q',
      acknowledge: 'immediately',
      prefetch: 0,
      assertQueue: true,
      assertExchange: true,
      durable: true,
      exclusive: false,
      autoDelete: false,
      bindings: [],
    });
  });

  it('needs a queue', () => {
    expect(() => settingsOf({}, '  ')).toThrow(/Queue/);
  });

  it('validates the parallel limit with the text of n8n', () => {
    for (const bad of [0, -2, 1.5, 'many']) {
      expect(() => settingsOf({ acknowledge: 'executionFinishes', parallelMessages: bad })).toThrow(
        PARALLEL_LIMIT_ERROR,
      );
    }
    expect(settingsOf({ acknowledge: 'executionFinishes', parallelMessages: 3 }).prefetch).toBe(3);
    expect(settingsOf({ acknowledge: 'executionFinishes', parallelMessages: -1 }).prefetch).toBe(0);
  });

  it('a limit with an immediate answer becomes "Execution Finishes"', () => {
    const settings = settingsOf({ acknowledge: 'immediately', parallelMessages: 2 });
    expect(settings.acknowledge).toBe('executionFinishes');
    expect(settings.prefetch).toBe(2);
  });

  it('a test run answers at once and takes one message', () => {
    const settings = settingsOf(
      { acknowledge: 'executionFinishesSuccessfully', parallelMessages: 5 },
      'q',
      'manual',
    );
    expect(settings).toMatchObject({ acknowledge: 'immediately', prefetch: 1, manual: true });
  });

  it('maps arguments, headers and bindings; numbers and booleans keep their type', () => {
    const settings = settingsOf({
      arguments: {
        argument: [
          { key: 'x-message-ttl', value: '60000' },
          { key: 'x-single-active-consumer', value: 'true' },
          { key: 'x-queue-type', value: 'classic' },
          { key: '  ', value: 'ignored' },
        ],
      },
      headers: { header: [{ key: 'format', value: 'pdf' }] },
      binding: {
        bindings: [
          { exchange: 'ex', routingKey: 'a.#' },
          { exchange: '', routingKey: 'x' },
        ],
      },
    });
    expect(settings.queueArguments).toEqual({
      'x-message-ttl': 60000,
      'x-single-active-consumer': true,
      'x-queue-type': 'classic',
    });
    expect(settings.bindingHeaders).toEqual({ format: 'pdf' });
    expect(settings.bindings).toEqual([{ exchange: 'ex', routingKey: 'a.#' }]);
  });

  it('binary content turns off parsing and only-content', () => {
    const settings = settingsOf({ contentIsBinary: true, jsonParseBody: true, onlyContent: true });
    expect(settings.message).toEqual({ contentIsBinary: true, jsonParseBody: false, onlyContent: false });
  });
});

describe('items from the real broker', () => {
  it('delivers a message as { content, fields, properties } and empties the queue (Immediately)', async () => {
    const queue = await newQueue('basic');
    const { runs } = await start({ queue, options: {} });
    publish(queue, 'hello', {
      contentType: 'text/plain',
      headers: { source: 'test', count: 3 },
      messageId: 'm1',
    });
    await until(() => runs.length === 1);
    const json = runs[0]!.items[0]!.json as DataObject & { fields: DataObject; properties: DataObject };
    expect(json.content).toBe('hello');
    expect(json.fields).toMatchObject({
      deliveryTag: 1,
      redelivered: false,
      exchange: '',
      routingKey: queue,
    });
    expect(json.fields.consumerTag).toEqual(expect.any(String));
    expect(json.properties).toMatchObject({
      contentType: 'text/plain',
      messageId: 'm1',
      headers: { source: 'test', count: 3 },
    });
    await until(async () => (await depth(queue)) === 0);
    expect(runs[0]!.done).toBeUndefined();
  });

  it('JSON Parse Body, and the text when the body is not JSON', async () => {
    const queue = await newQueue('json');
    const { runs, logs } = await start({ queue, options: { jsonParseBody: true } });
    publish(queue, '{"a":1,"b":[2]}');
    publish(queue, 'not json');
    await until(() => runs.length === 2);
    expect((runs[0]!.items[0]!.json as DataObject).content).toEqual({ a: 1, b: [2] });
    expect((runs[1]!.items[0]!.json as DataObject).content).toBe('not json');
    expect(logs.join('\n')).toContain('Could not parse the message body');
  });

  it('Only Content returns the content, wrapped when it is not an object', async () => {
    const queue = await newQueue('only');
    const { runs } = await start({ queue, options: { onlyContent: true, jsonParseBody: true } });
    publish(queue, '{"a":1}');
    publish(queue, 'plain');
    await until(() => runs.length === 2);
    expect(runs[0]!.items[0]!.json).toEqual({ a: 1 });
    expect(runs[1]!.items[0]!.json).toEqual({ content: 'plain' });
  });

  it('Content Is Binary keeps the body as binary data and leaves the content empty', async () => {
    const queue = await newQueue('binary');
    const { runs } = await start({ queue, options: { contentIsBinary: true } });
    const bytes = Buffer.from([0, 1, 2, 250, 251]);
    publish(queue, bytes, { contentType: 'application/x-test' });
    await until(() => runs.length === 1);
    const item = runs[0]!.items[0]!;
    expect((item.json as DataObject).content).toBe('');
    expect(item.binary?.data).toBeDefined();
    expect(item.binary!.data.mimeType).toBe('application/x-test');
  });

  it('binds to an exchange it declares, and takes what is published to it', async () => {
    const queue = await newQueue('bound');
    const exchange = unique('ex');
    closers.push(() => sideChannel.deleteExchange(exchange).catch(() => undefined));
    const { runs } = await start({
      queue,
      options: { binding: { bindings: [{ exchange, routingKey: 'orders.*' }] } },
    });
    sideChannel.publish(exchange, 'orders.new', Buffer.from('via exchange'));
    sideChannel.publish(exchange, 'other.thing', Buffer.from('not bound'));
    await until(() => runs.length === 1);
    await sleep(200);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.items[0]!.json as DataObject).content).toBe('via exchange');
    expect(((runs[0]!.items[0]!.json as DataObject).fields as DataObject).exchange).toBe(exchange);
  });

  it('uses an existing exchange of another type as it is', async () => {
    const queue = await newQueue('fanout');
    const exchange = unique('fanex');
    await sideChannel.assertExchange(exchange, 'fanout', { durable: false });
    closers.push(() => sideChannel.deleteExchange(exchange).catch(() => undefined));
    const { runs } = await start({
      queue,
      options: { binding: { bindings: [{ exchange, routingKey: '' }] } },
    });
    sideChannel.publish(exchange, '', Buffer.from('fan'));
    await until(() => runs.length === 1);
  });

  it('declares the queue with its arguments, and Assert Queue off needs the queue to exist', async () => {
    const queue = unique('declared');
    closers.push(() => sideChannel.deleteQueue(queue).catch(() => undefined));
    const first = await start({
      queue,
      options: { arguments: { argument: [{ key: 'x-max-length', value: '5' }] } },
    });
    publish(queue, 'in declared');
    await until(() => first.runs.length === 1);

    const missing = harness({ queue: unique('missing'), options: { assertQueue: false } });
    await expect(nodeType().trigger!(missing.ctx)).rejects.toThrow(/NOT_FOUND/);
    // the thrown reason is the only report: an emitError would replace it in a test listen
    expect(missing.errors).toEqual([]);
    await first.response.closeFunction!();
    const existing = await start({ queue, options: { assertQueue: false } });
    publish(queue, 'second');
    await until(() => existing.runs.length === 1);
  });
});

describe('acknowledge modes on the broker', () => {
  it('Execution Finishes: the message stays unacknowledged while the run goes, and goes after it ends', async () => {
    const queue = await newQueue('finishes');
    const held: EmittedRun[] = [];
    const { runs, response } = await start(
      { queue, options: { acknowledge: 'executionFinishes' } },
      { onRun: (run) => void held.push(run) },
    );
    publish(queue, 'one');
    await until(() => runs.length === 1);
    expect(runs[0]!.done).toBeDefined();
    held[0]!.done!.resolve({ executionId: 'e1', status: 'error' });
    await sleep(300);
    // the run failed and the message is gone all the same: a message left unanswered would come back now
    await response.closeFunction!();
    await sleep(300);
    expect(await depth(queue)).toBe(0);
  });

  it('Execution Finishes Successfully: an error puts the message back, a success removes it', async () => {
    const queue = await newQueue('success');
    const { runs } = await start(
      { queue, options: { acknowledge: 'executionFinishesSuccessfully' } },
      {
        onRun: (run, index) =>
          run.done!.resolve({ executionId: `e${index}`, status: index === 0 ? 'error' : 'success' }),
      },
    );
    publish(queue, 'retry me');
    await until(() => runs.length === 2);
    const second = runs[1]!.items[0]!.json as DataObject & { fields: DataObject };
    expect(second.content).toBe('retry me');
    expect(second.fields.redelivered).toBe(true);
    await sleep(300);
    expect(runs).toHaveLength(2);
    expect(await depth(queue)).toBe(0);
  });

  it('a run that cannot start puts the message back', async () => {
    const queue = await newQueue('nostart');
    const { runs } = await start(
      { queue, options: { acknowledge: 'executionFinishes' } },
      {
        onRun: (run, index) =>
          index === 0
            ? run.done!.reject(new Error('queue full'))
            : run.done!.resolve({ executionId: 'e2', status: 'success' }),
      },
    );
    publish(queue, 'again');
    await until(() => runs.length === 2);
    expect(((runs[1]!.items[0]!.json as DataObject).fields as DataObject).redelivered).toBe(true);
  });

  it('Specified Later: the response hook answers the broker before the run ends', async () => {
    const queue = await newQueue('later');
    const held: EmittedRun[] = [];
    const { runs } = await start(
      { queue, options: { acknowledge: 'laterMessageNode' } },
      { onRun: (run) => void held.push(run) },
    );
    publish(queue, 'later');
    await until(() => runs.length === 1);
    expect(runs[0]!.hook).toBeTypeOf('function');
    expect(runs[0]!.done).toBeDefined();
    runs[0]!.hook!({});
    // the run is still going, and the message is already answered: closing now leaves nothing to redeliver
    await sideChannel.checkQueue(queue);
    held[0]!.done!.resolve({ executionId: 'e1', status: 'error' });
    await sleep(300);
    expect(await depth(queue)).toBe(0);
  });

  it('Specified Later: without a hook the end of the run answers, nack on an error', async () => {
    const queue = await newQueue('later-end');
    const { runs } = await start(
      { queue, options: { acknowledge: 'laterMessageNode' } },
      {
        onRun: (run, index) =>
          run.done!.resolve({ executionId: `e${index}`, status: index === 0 ? 'error' : 'success' }),
      },
    );
    publish(queue, 'end');
    await until(() => runs.length === 2);
    expect(((runs[1]!.items[0]!.json as DataObject).fields as DataObject).redelivered).toBe(true);
  });

  it('the parallel limit is the prefetch: no more than the limit are handed out at once', async () => {
    const queue = await newQueue('prefetch');
    const held: EmittedRun[] = [];
    const { runs } = await start(
      { queue, options: { acknowledge: 'executionFinishes', parallelMessages: 2 } },
      { onRun: (run) => void held.push(run) },
    );
    for (let i = 0; i < 5; i += 1) publish(queue, `m${i}`);
    await until(() => runs.length === 2);
    await sleep(300);
    expect(runs).toHaveLength(2);
    held[0]!.done!.resolve({ executionId: 'a', status: 'success' });
    await until(() => runs.length === 3);
    await sleep(200);
    expect(runs).toHaveLength(3);
  });
});

describe('test run', () => {
  it('takes the message that waits in the queue, and only that one', async () => {
    const queue = await newQueue('manual-get');
    publish(queue, 'first');
    publish(queue, 'second');
    await until(async () => (await depth(queue)) === 2);
    const { runs, response } = await start({ queue, options: {} }, { mode: 'manual' });
    await response.manualTriggerFunction!();
    expect(runs).toHaveLength(1);
    expect((runs[0]!.items[0]!.json as DataObject).content).toBe('first');
    expect(runs[0]!.done).toBeUndefined();
    await sleep(300);
    expect(runs).toHaveLength(1);
    expect(await depth(queue)).toBe(1);
  });

  it('with an empty queue it takes the next message that arrives, and leaves the rest', async () => {
    const queue = await newQueue('manual-wait');
    const { runs, response } = await start({ queue, options: {} }, { mode: 'manual' });
    await response.manualTriggerFunction!();
    publish(queue, 'arrives');
    publish(queue, 'stays 1');
    publish(queue, 'stays 2');
    await until(() => runs.length === 1);
    await sleep(500);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.items[0]!.json as DataObject).content).toBe('arrives');
    await until(async () => (await depth(queue)) === 2);
  });
});

describe('close and failures', () => {
  it('after the close a message left open goes back to the queue and is not lost', async () => {
    const queue = await newQueue('close');
    const { runs, response } = await start(
      { queue, options: { acknowledge: 'executionFinishes' } },
      { onRun: () => undefined },
    );
    publish(queue, 'open run');
    await until(() => runs.length === 1);
    const stop = Date.now();
    // the run never ends: the close gives up after its bound (10 s by default) and the broker redelivers
    const closing = response.closeFunction!();
    const outcome = await Promise.race([closing.then(() => 'closed'), sleep(11_500).then(() => 'late')]);
    expect(outcome).toBe('closed');
    expect(Date.now() - stop).toBeGreaterThanOrEqual(9_000);
    await until(async () => (await depth(queue)) === 1);
  }, 30_000);

  it('a close with no run in flight is immediate', async () => {
    const queue = await newQueue('close-fast');
    const { response } = await start({ queue, options: {} });
    const stop = Date.now();
    await response.closeFunction!();
    expect(Date.now() - stop).toBeLessThan(2_000);
  });

  it('a connection that drops after the start goes to emitError', async () => {
    const queue = await newQueue('drop');
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const upstream = net.connect(PORT, '127.0.0.1');
      sockets.add(client);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
      client.on('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => proxy.close(resolve)));
    const { errors } = await start(
      { queue, options: {} },
      {
        creds: brokerCredentials({ hostname: '127.0.0.1', port: (proxy.address() as net.AddressInfo).port }),
      },
    );
    for (const socket of sockets) socket.destroy();
    await until(() => errors.length >= 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/RabbitMQ/);
    expect(errors[0]!.message).not.toContain(BROKER.password);
  });

  it('a wrong password fails the start with a fixed text', async () => {
    const queue = await newQueue('badpass');
    const h = harness({ queue, options: {} }, { creds: brokerCredentials({ password: 'not-the-password' }) });
    const error = await nodeType().trigger!(h.ctx).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe('RabbitMQ refused the username or password');
  });

  it('a wrong virtual host fails the start without the broker text', async () => {
    const queue = await newQueue('badvhost');
    const h = harness(
      { queue, options: {} },
      { creds: brokerCredentials({ vhost: 'no-such-vhost-secret' }) },
    );
    const error = await nodeType().trigger!(h.ctx).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe('RabbitMQ refused access to the virtual host');
    expect(error?.message).not.toContain('no-such-vhost-secret');
  });
});

describe('SSRF guard', () => {
  it('a blocked host fails the start at once and opens no socket', async () => {
    const h = harness(
      { queue: 'q', options: {} },
      { httpClient: new HttpClient(), creds: brokerCredentials() },
    );
    const before = Date.now();
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(/blocked/);
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('connects through the checked address of a name DNS does not know', async () => {
    const queue = await newQueue('pinned');
    const checked: string[] = [];
    const guard = new (class extends HttpClient {
      constructor() {
        super({ ssrf: { allow: ['127.0.0.1'] } });
      }
      override async resolveAllowedHost(host: string) {
        checked.push(host);
        return super.resolveAllowedHost('127.0.0.1');
      }
    })();
    const { runs } = await start(
      { queue, options: {} },
      { httpClient: guard, creds: brokerCredentials({ hostname: 'rabbit-rebind.test' }) },
    );
    publish(queue, 'through the guard');
    await until(() => runs.length === 1);
    expect(checked).toContain('rabbit-rebind.test');
  });
});

describe('credential test', () => {
  const testContext = (httpClient: HttpClient = localHttp()) => ({
    helpers: {
      resolveAllowedHost: (host: string) => httpClient.resolveAllowedHost(host),
      assertHostAllowed: (host: string) => httpClient.assertHostAllowed(host),
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    signal: new AbortController().signal,
    getTenantId: () => 't1',
  });
  const run = (data: DataObject, httpClient?: HttpClient) =>
    rabbitmqCredentialTest(testContext(httpClient), { type: 'rabbitmq', data });

  it('passes with the right password', async () => {
    expect(await run(brokerCredentials())).toEqual({ status: 'OK', message: 'Connection successful' });
  });

  it('fails clearly with a wrong password, and the text carries no secret', async () => {
    const result = await run(brokerCredentials({ password: 'hunter2-wrong' }));
    expect(result).toEqual({ status: 'Error', message: 'RabbitMQ refused the username or password' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('fails when nothing listens, and when the host is blocked', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const refused = await run(brokerCredentials({ port: closedPort }));
    expect(refused.status).toBe('Error');
    expect(refused.message).toMatch(/Couldn't connect to RabbitMQ/);
    const blocked = await run(brokerCredentials(), new HttpClient());
    expect(blocked.status).toBe('Error');
    expect(blocked.message).toMatch(/blocked/);
  });

  it('fails on an unusable field without connecting', async () => {
    expect(await run(brokerCredentials({ hostname: '' }))).toEqual({
      status: 'Error',
      message: 'Enter the RabbitMQ hostname',
    });
  });

  it('a broker that closes after the sign-in never gets its words into the answer', async () => {
    const words =
      'Connection closed: 320 (CONNECTION-FORCED) with message "CONNECTION_FORCED - broker words"';
    const refused = vi
      .spyOn(Object.getPrototypeOf(side), 'createChannel')
      .mockRejectedValueOnce(new Error(words));
    try {
      expect(await run(brokerCredentials())).toEqual({
        status: 'Error',
        message: "Couldn't connect to RabbitMQ",
      });
    } finally {
      refused.mockRestore();
    }
  });
});

describe('tracker on a fake channel', () => {
  const message = (tag: number): ConsumeMessage =>
    ({
      content: Buffer.from(`m${tag}`),
      fields: { deliveryTag: tag, consumerTag: 'c', redelivered: false, exchange: '', routingKey: 'q' },
      properties: {},
    }) as unknown as ConsumeMessage;

  function fake(
    mode: Parameters<typeof createTracker>[0]['mode'],
    closeWaitMs?: number,
    retryDelayMs?: number,
  ) {
    const calls: string[] = [];
    const runs: EmittedRun[] = [];
    const warnings: string[] = [];
    const tracker = createTracker({
      channel: {
        ack: (m) => void calls.push(`ack ${m.fields.deliveryTag}`),
        nack: (m, _all, requeue) =>
          void calls.push(`${requeue ? 'requeue' : 'reject'} ${m.fields.deliveryTag}`),
      },
      mode,
      parse: async (m) => ({ json: { content: m.content.toString() } }),
      emit: (data, done, hook) => void runs.push({ items: data[0] ?? [], done, hook }),
      logger: { debug: () => undefined, warn: (m: string) => void warnings.push(m) },
      closeWaitMs,
      retryDelayMs,
    });
    return { tracker, calls, runs, warnings };
  }

  it('Immediately answers before the run and gives no run result to wait for', async () => {
    const { tracker, calls, runs } = fake('immediately');
    await tracker.handle(message(1));
    expect(calls).toEqual(['ack 1']);
    expect(runs[0]!.done).toBeUndefined();
  });

  it('answers a message once, whatever comes first', async () => {
    const { tracker, calls, runs } = fake('laterMessageNode');
    const handled = tracker.handle(message(1));
    await tick();
    runs[0]!.hook!({});
    runs[0]!.hook!({ statusCode: 200 });
    runs[0]!.done!.resolve({ executionId: 'e', status: 'error' });
    await handled;
    expect(calls).toEqual(['ack 1']);
  });

  it('only a failed run goes back in "Execution Finishes Successfully"; a run at a Wait node is done', async () => {
    const { tracker, calls, runs } = fake('executionFinishesSuccessfully');
    const jobs = [1, 2, 3, 4, 5].map((tag) => tracker.handle(message(tag)));
    await tick();
    runs[0]!.done!.resolve({ executionId: 'a', status: 'success' });
    runs[1]!.done!.resolve({ executionId: 'b', status: 'crashed' });
    runs[2]!.done!.resolve({ executionId: 'c', status: 'waiting' });
    runs[3]!.done!.resolve({ executionId: 'd', status: 'error' });
    runs[4]!.done!.resolve({ executionId: 'e', status: 'canceled' });
    await Promise.all(jobs);
    expect(calls).toEqual(['ack 1', 'requeue 2', 'ack 3', 'requeue 4', 'requeue 5']);
  });

  it('Specified Later: a run at a Wait node is done, as is a run that ends without the node', async () => {
    const { tracker, calls, runs } = fake('laterMessageNode');
    const jobs = [1, 2, 3].map((tag) => tracker.handle(message(tag)));
    await tick();
    runs[0]!.done!.resolve({ executionId: 'a', status: 'waiting' });
    runs[1]!.done!.resolve({ executionId: 'b', status: 'success' });
    runs[2]!.done!.resolve({ executionId: 'c', status: 'error' });
    await Promise.all(jobs);
    expect(calls).toEqual(['ack 1', 'ack 2', 'requeue 3']);
  });

  it('a run that cannot start waits before its message goes back', async () => {
    const { tracker, calls, runs } = fake('executionFinishes', undefined, 150);
    const job = tracker.handle(message(1));
    await tick();
    runs[0]!.done!.reject(new Error('limit reached'));
    await sleep(50);
    expect(calls).toEqual([]);
    expect(tracker.inFlight()).toBe(1);
    await job;
    expect(calls).toEqual(['requeue 1']);
  });

  it('a stop ends the wait of a run that could not start', async () => {
    const { tracker, calls, runs } = fake('executionFinishes', undefined, 60_000);
    const job = tracker.handle(message(1));
    await tick();
    runs[0]!.done!.reject(new Error('limit reached'));
    await tick();
    expect(calls).toEqual([]);
    tracker.stop();
    await tracker.drain();
    await job;
    expect(calls).toEqual(['requeue 1']);
  });

  it('a message that cannot be read gets no answer: it is neither lost nor looped', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const tracker = createTracker({
      channel: {
        ack: (m) => void calls.push(`ack ${m.fields.deliveryTag}`),
        nack: (m, _a, requeue) =>
          void calls.push(`${requeue ? 'requeue' : 'reject'} ${m.fields.deliveryTag}`),
      },
      mode: 'executionFinishesSuccessfully',
      parse: async () => {
        throw new Error('too large');
      },
      emit: () => undefined,
      logger: { debug: () => undefined, warn: (m: string) => void warnings.push(m) },
    });
    await tracker.handle(message(7));
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(tracker.inFlight()).toBe(0);
  });

  it('an answer on a closed channel is dropped without a throw', async () => {
    const tracker = createTracker({
      channel: {
        ack: () => {
          throw new Error('Channel closed');
        },
        nack: () => undefined,
      },
      mode: 'immediately',
      parse: async () => ({ json: {} }),
      emit: () => undefined,
      logger: { debug: () => undefined, warn: () => undefined },
    });
    await expect(tracker.handle(message(1))).resolves.toBeUndefined();
  });

  it('after stop a new message goes back, and drain waits for runs up to its bound', async () => {
    const { tracker, calls, runs } = fake('executionFinishes', 200);
    const open = tracker.handle(message(1));
    await tick();
    expect(tracker.inFlight()).toBe(1);
    tracker.stop();
    await tracker.handle(message(2));
    expect(calls).toEqual(['requeue 2']);
    const before = Date.now();
    await tracker.drain();
    const waited = Date.now() - before;
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(1500);
    // the run ends later: its answer is still sent if the channel lives
    runs[0]!.done!.resolve({ executionId: 'e', status: 'success' });
    await open;
    expect(calls).toEqual(['requeue 2', 'ack 1']);
    const quick = Date.now();
    await tracker.drain();
    expect(Date.now() - quick).toBeLessThan(100);
  });

  it('drain returns as soon as the runs end', async () => {
    const { tracker, runs } = fake('executionFinishes', 5_000);
    void tracker.handle(message(1));
    await tick();
    const before = Date.now();
    const draining = tracker.drain();
    runs[0]!.done!.resolve({ executionId: 'e', status: 'success' });
    await draining;
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('turns broker tables into plain JSON in the item', async () => {
    const parse = createMessageParser(
      {
        logger: { warn: () => undefined },
        helpers: { prepareBinaryData: async () => ({}) as never },
      },
      { contentIsBinary: false, jsonParseBody: false, onlyContent: false },
    );
    const item = await parse({
      content: Buffer.from('x'),
      fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: 'r' },
      properties: {
        headers: { raw: Buffer.from('bytes'), big: 2n ** 70n, small: 5n, nested: { when: new Date(0) } },
        timestamp: 10,
      },
    } as never);
    expect((item.json as DataObject).properties).toMatchObject({
      headers: {
        raw: 'bytes',
        big: (2n ** 70n).toString(),
        small: 5,
        nested: { when: '1970-01-01T00:00:00.000Z' },
      },
      timestamp: 10,
    });
    expect(() => JSON.stringify(item)).not.toThrow();
  });
});
