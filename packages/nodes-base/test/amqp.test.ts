/**
 * AMQP Trigger and AMQP Sender against an in-process rhea listener (a small AMQP 1.0 broker with PLAIN
 * sign-in, queues, TLS and the link settings the nodes ask for).
 */
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import type { Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createTriggerContext, HttpClient } from '@workflow/core';
import {
  type AllowedHost,
  type CredentialTestContext,
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type TriggerResponse,
  type TriggerRunResult,
  Workflow,
} from '@workflow/workflow';
import rhea from 'rhea';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentials as allCredentials, nodes } from '../src';
import {
  amqpCredentialTest,
  describeConnectError,
  jsonSafe,
  messageToJson,
  readEndpoint,
} from '../src/nodes/apps/amqp/connect';
import { TEST_CERT, TEST_KEY } from './imap-server';
import { node, nodeTypes, runNode, testServices } from './harness';
import { localHttp } from './servers';

const USER = 'workflow';
const PASSWORD = `pw-${randomUUID().slice(0, 8)}`;
const unique = (name: string) => `l21-${name}-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (check: () => boolean | Promise<boolean>, timeout = 15_000) =>
  vi.waitFor(
    async () => {
      expect(await check()).toBe(true);
    },
    { timeout, interval: 25 },
  );

// ---- the broker ----

interface QueueState {
  waiting: Array<Record<string, unknown>>;
  receivers: Set<any>;
}
interface LinkSeen {
  address: string;
  name: string;
  durable?: unknown;
  expiry?: unknown;
  containerId?: string;
  credit: number;
}

class TestBroker {
  readonly container = rhea.create_container();
  readonly queues = new Map<string, QueueState>();
  readonly received: Array<{ address: string; message: Record<string, any> }> = [];
  readonly links: LinkSeen[] = [];
  readonly accepted: string[] = [];
  readonly servernames: string[] = [];
  readonly credits: number[] = [];
  readonly sockets = new Set<{ destroy(): void }>();
  /** link credit seen on each consumer link when it opened */
  connections = 0;
  rejectIncoming = false;
  server!: Server;
  port = 0;

  constructor(private readonly useTls = false) {
    const c = this.container;
    c.sasl_server_mechanisms.enable_plain((user: string, password: string) => user === USER && password === PASSWORD);
    c.on('connection_open', () => void 0);
    c.on('message', (context: any) => {
      const address = context.receiver.target.address as string;
      const message = context.message as Record<string, any>;
      if (this.rejectIncoming) {
        context.delivery.reject({ condition: 'amqp:internal-error', description: 'no' });
        return;
      }
      this.received.push({ address, message });
      this.queue(address).waiting.push(message);
      this.flush(address);
    });
    c.on('sender_open', (context: any) => {
      const address = context.sender.source.address as string;
      this.links.push({
        address,
        name: context.sender.name,
        durable: context.sender.source.durable,
        expiry: context.sender.source.expiry_policy,
        containerId: context.connection.remote?.open?.container_id,
        credit: context.sender.credit,
      });
      this.queue(address).receivers.add(context.sender);
    });
    c.on('sender_close', (context: any) => {
      this.queue(context.sender.source.address).receivers.delete(context.sender);
    });
    c.on('sendable', (context: any) => {
      this.credits.push(context.sender.credit);
      this.flush(context.sender.source.address);
    });
    c.on('accepted', (context: any) => this.accepted.push(String(context.delivery.id)));
  }

  queue(address: string): QueueState {
    let state = this.queues.get(address);
    if (!state) this.queues.set(address, (state = { waiting: [], receivers: new Set() }));
    return state;
  }

  /** give waiting messages to the consumers that have credit */
  flush(address: string) {
    const state = this.queue(address);
    for (const sender of state.receivers) {
      while (state.waiting.length > 0 && sender.sendable()) sender.send(state.waiting.shift());
    }
  }

  /** put a message on a queue, as another client would */
  put(address: string, body: unknown, extra: Record<string, unknown> = {}) {
    this.queue(address).waiting.push({ body, ...extra });
    this.flush(address);
  }

  /** deliveries a consumer link was given and has not answered yet */
  unsettled(address: string): number {
    let count = 0;
    for (const sender of this.queue(address).receivers) count += sender.session?.outgoing?.deliveries?.size?.() ?? 0;
    return count;
  }

  async start(): Promise<this> {
    const options = this.useTls ? { port: 0, transport: 'tls', cert: TEST_CERT, key: TEST_KEY } : { port: 0 };
    this.server = (this.container as any).listen(options) as Server;
    this.server.on('connection', (socket) => {
      this.connections++;
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
        // a client that went away takes its consumer links with it
        for (const state of this.queues.values()) {
          for (const sender of [...state.receivers]) if (sender.connection?.socket === socket) state.receivers.delete(sender);
        }
      });
    });
    this.server.on('secureConnection', (socket: { servername?: string }) => this.servernames.push(String(socket.servername)));
    this.server.on('error', () => void 0);
    await new Promise<void>((resolve) => this.server.once('listening', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop() {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // close() waits for open sockets
      this.container.removeAllListeners();
      setTimeout(resolve, 500);
    });
  }

  /** the broker drops every client socket */
  dropClients() {
    for (const socket of this.sockets) socket.destroy();
  }

  creds(overrides: DataObject = {}): DataObject {
    return {
      hostname: '127.0.0.1',
      port: this.port,
      username: USER,
      password: PASSWORD,
      transportType: this.useTls ? 'tls' : 'tcp',
      ...(this.useTls ? { ca: TEST_CERT } : {}),
      ...overrides,
    };
  }
}

const brokers: TestBroker[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  await Promise.allSettled(brokers.splice(0).map((broker) => broker.stop()));
});
async function newBroker(useTls = false) {
  const broker = await new TestBroker(useTls).start();
  brokers.push(broker);
  return broker;
}

// ---- trigger harness ----

interface EmittedRun {
  items: Item[];
  done?: { resolve(r: TriggerRunResult): void; reject(e: Error): void };
}
interface HarnessOptions {
  creds?: DataObject;
  httpClient?: HttpClient;
  mode?: 'activate' | 'manual';
  /** answer each run; without it runs are answered with `success` */
  onRun?: (run: EmittedRun, index: number) => void;
}

function harness(parameters: DataObject, options: HarnessOptions) {
  const logs: string[] = [];
  const record = (message: unknown) => void logs.push(String(message));
  const logger = { debug: record, info: record, warn: record, error: record };
  const wfNode = node('AMQP Trigger', 'app.amqpTrigger', parameters, [0, 0], {
    credentials: { amqp: { id: 'amqp', name: 'amqp' } },
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
      services: testServices(
        { amqp: options.creds ?? {} },
        {
          mode: options.mode === 'manual' ? 'manual' : 'trigger',
          http: options.httpClient ?? localHttp(),
          logger: logger as never,
        },
      ),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    {
      activationMode: options.mode ?? 'activate',
      emit: (data, done) => {
        const run: EmittedRun = { items: data[0] ?? [], done };
        runs.push(run);
        if (options.onRun) options.onRun(run, runs.length - 1);
        else done?.resolve({ executionId: `run-${runs.length}`, status: 'success' });
      },
      emitError: (error) => void errors.push(error),
    },
  );
  return { ctx, runs, errors, logs };
}

const triggerType = () => nodes.find((n) => n.description.name === 'app.amqpTrigger')!;
const senderType = () => nodes.find((n) => n.description.name === 'app.amqp')!;

async function start(broker: TestBroker, parameters: DataObject, options: Partial<HarnessOptions> = {}) {
  const h = harness(parameters, { creds: broker.creds(), ...options });
  const response = (await triggerType().trigger!(h.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...h, response };
}

const testContext = (http: HttpClient = localHttp()): CredentialTestContext => ({
  helpers: {
    resolveAllowedHost: (host: string) => http.resolveAllowedHost(host),
    assertHostAllowed: (host: string) => http.assertHostAllowed(host),
  },
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
  signal: new AbortController().signal,
  getTenantId: () => 't1',
});

/** an HTTP client whose guard answers per host name, as the real one does */
class ScriptedGuard extends HttpClient {
  checked: string[] = [];
  constructor(private answer: (host: string) => AllowedHost | Error) {
    super({ ssrf: { allow: ['127.0.0.1'] } });
  }
  override async resolveAllowedHost(host: string): Promise<AllowedHost> {
    this.checked.push(host);
    const answer = this.answer(host);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
const pinnedLoopback = (): AllowedHost => ({
  addresses: [{ address: '127.0.0.1', family: 4 }],
  lookup(_hostname, options, callback) {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  },
});

// ---- tests ----

describe('node and credential', () => {
  it('has the names, the fields and the options of n8n and a credential test', () => {
    const trigger = triggerType();
    expect(trigger.description.displayName).toBe('AMQP Trigger');
    expect(trigger.description.properties.map((p) => p.name)).toEqual(['sink', 'clientname', 'subscription', 'options']);
    const options = trigger.description.properties.find((p) => p.name === 'options')!;
    expect((options.options as Array<{ name: string }>).map((o) => o.name)).toEqual(
      expect.arrayContaining([
        'containerId',
        'convertBodyToString',
        'jsonParseBody',
        'pullMessagesNumber',
        'onlyBody',
        'parallelProcessing',
        'reconnect',
        'reconnectLimit',
        'sleepTime',
      ]),
    );
    const sender = senderType();
    expect(sender.description.displayName).toBe('AMQP Sender');
    expect(sender.description.properties.map((p) => p.name)).toEqual(['sink', 'headerParametersJson', 'options']);
    for (const type of [trigger, sender]) {
      expect(type.description.credentials?.[0]).toMatchObject({ name: 'amqp', testedBy: 'amqpCredentialTest' });
      expect(type.methods?.credentialTest?.amqpCredentialTest).toBe(amqpCredentialTest);
    }
  });

  it('the credential has the fields of n8n, hides the password and asks for no HTTP domains', () => {
    const credential = allCredentials.find((c) => c.name === 'amqp')!;
    expect(credential.hideDomainRestrictionFields).toBe(true);
    expect(credential.properties.map((p) => p.name)).toEqual([
      'hostname',
      'port',
      'username',
      'password',
      'transportType',
      'ca',
    ]);
    expect(credential.properties.find((p) => p.name === 'password')!.typeOptions?.password).toBe(true);
    expect(credential.properties.find((p) => p.name === 'port')!.default).toBe(5672);
  });

  it('reads the endpoint and refuses a bad port or an empty host', () => {
    expect(readEndpoint({ hostname: ' [::1] ', port: '5673', transportType: 'tls' })).toEqual({
      host: '::1',
      port: 5673,
      transport: 'tls',
    });
    expect(() => readEndpoint({ hostname: '' })).toThrow('Enter the AMQP hostname');
    expect(() => readEndpoint({ hostname: 'h', port: 70000 })).toThrow('port');
  });
});

describe('message conversion', () => {
  const off = { convertBodyToString: false, jsonParseBody: false, onlyBody: false };

  it('parses JSON text, converts bytes and keeps bytes JSON-shaped when not converted', () => {
    const section = { typecode: 0x75, content: Buffer.from('{"a":1}'), multiple: false };
    expect(messageToJson({ body: '{"a":1}' }, { ...off, jsonParseBody: true, onlyBody: true })).toEqual({ a: 1 });
    expect(messageToJson({ body: section }, { ...off, convertBodyToString: true, onlyBody: true })).toEqual({
      message: '{"a":1}',
    });
    expect(
      messageToJson({ body: section }, { convertBodyToString: true, jsonParseBody: true, onlyBody: true }),
    ).toEqual({ a: 1 });
    expect((messageToJson({ body: section }, off) as { body: { type: string } }).body.type).toBe('Buffer');
  });

  it('a body that is not an object becomes { message } and text that is not JSON stays text', () => {
    expect(messageToJson({ body: 'plain' }, { ...off, onlyBody: true })).toEqual({ message: 'plain' });
    expect(messageToJson({ body: 42 }, { ...off, onlyBody: true })).toEqual({ message: 42 });
    expect(messageToJson({ body: 'not json' }, { ...off, jsonParseBody: true, onlyBody: true })).toEqual({
      message: 'not json',
    });
  });

  it('keeps the properties of the message JSON-safe', () => {
    const json = messageToJson(
      { body: 'x', message_id: 9n, creation_time: new Date(0), correlation_id: Buffer.from('ab') },
      off,
    );
    expect(json).toMatchObject({ body: 'x', message_id: '9', creation_time: '1970-01-01T00:00:00.000Z' });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(jsonSafe(undefined)).toBeNull();
  });
});

describe('AMQP Trigger', () => {
  it('starts a run from a message of the broker, with the body and properties', async () => {
    const broker = await newBroker();
    const queue = unique('basic');
    const { runs } = await start(broker, { sink: queue, options: { jsonParseBody: true } });
    broker.put(queue, '{"order":7}', { application_properties: { source: 'shop' }, subject: 'new' });
    await until(() => runs.length === 1);
    const json = runs[0]!.items[0]!.json as DataObject;
    expect(json.body).toEqual({ order: 7 });
    expect(json.application_properties).toEqual({ source: 'shop' });
    expect(json.subject).toBe('new');
  });

  it('a message sent by the sender node arrives as a run', async () => {
    const broker = await newBroker();
    const queue = unique('roundtrip');
    const { runs } = await start(broker, { sink: queue, options: { jsonParseBody: true, onlyBody: true } });
    const sent = await runNode('app.amqp', { sink: queue, options: {} }, [{ json: { hello: 'world', n: 3 } }], {
      creds: { amqp: broker.creds() },
      services: { http: localHttp() },
    });
    expect(sent.status).toBe('success');
    expect(sent.outputs[0]).toEqual([expect.objectContaining({ sent: true, sink: queue })]);
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json).toEqual({ hello: 'world', n: 3 });
  });

  it('Only Body returns the body; text that is not an object becomes { message }', async () => {
    const broker = await newBroker();
    const queue = unique('only');
    const { runs } = await start(broker, { sink: queue, options: { onlyBody: true } });
    broker.put(queue, 'just text');
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json).toEqual({ message: 'just text' });
  });

  it('converts a body sent as bytes to text', async () => {
    const broker = await newBroker();
    const queue = unique('bytes');
    const { runs } = await start(broker, { sink: queue, options: { onlyBody: true, convertBodyToString: true } });
    broker.put(queue, rhea.message.data_section(Buffer.from('from bytes')));
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json).toEqual({ message: 'from bytes' });
  });

  it('Messages per Cycle is the credit the broker gets', async () => {
    const broker = await newBroker();
    const queue = unique('credit');
    await start(broker, { sink: queue, options: { pullMessagesNumber: 7 } });
    await until(() => broker.credits.length > 0);
    expect(broker.credits[0]).toBe(7);
  });

  it('without Parallel Processing the next message waits until the run ends', async () => {
    const broker = await newBroker();
    const queue = unique('serial');
    const { runs } = await start(
      broker,
      { sink: queue, options: { parallelProcessing: false, onlyBody: true } },
      { onRun: () => undefined },
    );
    for (const n of [1, 2, 3]) broker.put(queue, { n });
    await until(() => runs.length === 1);
    await sleep(300);
    expect(runs).toHaveLength(1);
    runs[0]!.done!.resolve({ executionId: 'a', status: 'success' });
    await until(() => runs.length === 2);
    await sleep(200);
    expect(runs).toHaveLength(2);
    runs[1]!.done!.resolve({ executionId: 'b', status: 'success' });
    await until(() => runs.length === 3);
    expect(runs.map((r) => r.items[0]!.json)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('with Parallel Processing the runs start without waiting for each other', async () => {
    const broker = await newBroker();
    const queue = unique('parallel');
    const { runs } = await start(broker, { sink: queue, options: {} }, { onRun: () => undefined });
    for (const n of [1, 2, 3]) broker.put(queue, { n });
    await until(() => runs.length === 3);
  });

  it('a durable subscription sets the container id, the link name and a durable source', async () => {
    const broker = await newBroker();
    const queue = unique('durable');
    await start(broker, { sink: queue, clientname: 'client-a', subscription: 'sub-a', options: {} });
    await until(() => broker.links.length === 1);
    expect(broker.links[0]).toMatchObject({
      address: queue,
      name: 'sub-a',
      durable: 2,
      expiry: 'never',
      containerId: 'client-a',
    });
  });

  it('a client name without a subscription is refused before any connection', async () => {
    const broker = await newBroker();
    const h = harness({ sink: 'q', clientname: 'only-a-name', options: {} }, { creds: broker.creds() });
    await expect(triggerType().trigger!(h.ctx)).rejects.toThrow('both a Client Name and a Subscription');
    expect(broker.connections).toBe(0);
  });

  it('the Container ID option names the client', async () => {
    const broker = await newBroker();
    const queue = unique('container');
    await start(broker, { sink: queue, options: { containerId: 'my-container' } });
    await until(() => broker.links.length === 1);
    expect(broker.links[0]!.containerId).toBe('my-container');
  });

  it('a test run takes one message and no more', async () => {
    const broker = await newBroker();
    const queue = unique('manual');
    const h = harness({ sink: queue, options: {} }, { creds: broker.creds(), mode: 'manual' });
    const response = (await triggerType().trigger!(h.ctx)) as TriggerResponse;
    closers.push(() => response.closeFunction?.());
    expect(response.manualTriggerFunction).toBeTypeOf('function');
    await response.manualTriggerFunction!();
    broker.put(queue, 'first');
    broker.put(queue, 'second');
    await until(() => h.runs.length === 1);
    await sleep(300);
    expect(h.runs).toHaveLength(1);
  });

  it('a wrong password fails the start with a fixed text that has no secret in it', async () => {
    const broker = await newBroker();
    const h = harness({ sink: 'q', options: {} }, { creds: broker.creds({ password: 'wrong-secret-word' }) });
    const error = await triggerType().trigger!(h.ctx).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The AMQP broker refused the username or password');
    expect(h.logs.join('\n')).not.toContain('wrong-secret-word');
  });

  it('an unreachable broker fails the start', async () => {
    const broker = await newBroker();
    const creds = broker.creds();
    await broker.stop();
    const h = harness({ sink: 'q', options: { reconnect: false } }, { creds });
    await expect(triggerType().trigger!(h.ctx)).rejects.toThrow("Couldn't connect to the AMQP broker");
  });

  it('a lost connection reconnects and goes on delivering', async () => {
    const broker = await newBroker();
    const queue = unique('reconnect');
    const { runs, errors } = await start(broker, { sink: queue, options: { sleepTime: 20 } });
    broker.put(queue, 'one');
    await until(() => runs.length === 1);
    broker.dropClients();
    await sleep(100);
    await until(() => broker.links.length >= 2, 15_000);
    broker.put(queue, 'two');
    await until(() => runs.length === 2);
    expect(errors).toHaveLength(0);
  });

  it('with Reconnect off a lost connection is reported as an error', async () => {
    const broker = await newBroker();
    const queue = unique('noreconnect');
    const { runs, errors } = await start(broker, { sink: queue, options: { reconnect: false } });
    broker.put(queue, 'one');
    await until(() => runs.length === 1);
    broker.dropClients();
    await until(() => errors.length === 1);
    expect(errors[0]!.message).not.toContain(PASSWORD);
  });

  it('closing the trigger closes the connection and stops the runs', async () => {
    const broker = await newBroker();
    const queue = unique('close');
    const { runs, response } = await start(broker, { sink: queue, options: {} });
    broker.put(queue, 'before');
    await until(() => runs.length === 1);
    await response.closeFunction!();
    broker.put(queue, 'after');
    await sleep(300);
    expect(runs).toHaveLength(1);
  });

  it('logs hold neither the password nor the message', async () => {
    const broker = await newBroker();
    const queue = unique('logs');
    const { runs, logs } = await start(broker, { sink: queue, options: {} });
    broker.put(queue, 'private payload');
    await until(() => runs.length === 1);
    expect(logs.join('\n')).not.toContain(PASSWORD);
    expect(logs.join('\n')).not.toContain('private payload');
  });
});

describe('AMQP Sender', () => {
  const send = (broker: TestBroker, parameters: DataObject, items: Item[], extra: DataObject = {}) =>
    runNode('app.amqp', parameters, items, {
      creds: { amqp: broker.creds(extra) },
      services: { http: localHttp() },
    });

  it('sends one message per item, as JSON text, with the headers as application properties', async () => {
    const broker = await newBroker();
    const queue = unique('send');
    const result = await send(
      broker,
      { sink: queue, headerParametersJson: '{"kind":"order"}', options: {} },
      [{ json: { a: 1 } }, { json: { a: 2 } }],
    );
    expect(result.status).toBe('success');
    expect(result.outputs[0]).toHaveLength(2);
    expect(broker.received.map((r) => r.message.body)).toEqual(['{"a":1}', '{"a":2}']);
    expect(broker.received[0]!.message.application_properties).toEqual({ kind: 'order' });
    expect(broker.received[0]!.address).toBe(queue);
  });

  it('Send Property sends only that property and Send As Object keeps an object an object', async () => {
    const broker = await newBroker();
    const queue = unique('prop');
    await send(
      broker,
      { sink: queue, options: { sendOnlyProperty: 'payload', dataAsObject: true } },
      [{ json: { payload: { x: 1 }, other: 'no' } }],
    );
    expect(broker.received[0]!.message.body).toEqual({ x: 1 });
    await send(broker, { sink: queue, options: { sendOnlyProperty: 'text' } }, [{ json: { text: 'hello' } }]);
    expect(broker.received[1]!.message.body).toBe('hello');
  });

  it('refuses Headers that are not a JSON object, and an empty queue', async () => {
    const broker = await newBroker();
    const bad = await send(broker, { sink: 'q', headerParametersJson: '[1]', options: {} }, [{ json: {} }]);
    expect(bad.status).toBe('error');
    expect(String(bad.error?.message)).toContain('Headers must be a JSON object');
    const empty = await send(broker, { sink: ' ', options: {} }, [{ json: {} }]);
    expect(String(empty.error?.message)).toContain('Queue / Topic is required');
    expect(broker.connections).toBe(0);
  });

  it('a broker that rejects the message fails the node, or continues with the error when asked', async () => {
    const broker = await newBroker();
    broker.rejectIncoming = true;
    const failed = await send(broker, { sink: 'q', options: {} }, [{ json: { a: 1 } }]);
    expect(failed.status).toBe('error');
    expect(String(failed.error?.message)).toBe('The AMQP broker rejected the message');
    const kept = await send(broker, { sink: 'q', options: {} }, [{ json: { a: 1 } }], {}).then(() =>
      runNode('app.amqp', { sink: 'q', options: {} }, [{ json: { a: 1 } }], {
        creds: { amqp: broker.creds() },
        node: { onError: 'continueRegularOutput' },
        services: { http: localHttp() },
      }),
    );
    expect(kept.status).toBe('success');
    expect(kept.outputs[0]![0]).toEqual({ error: 'The AMQP broker rejected the message' });
  });

  it('a wrong password fails with the fixed text', async () => {
    const broker = await newBroker();
    const result = await send(broker, { sink: 'q', options: {} }, [{ json: {} }], { password: 'nope-secret' });
    expect(result.status).toBe('error');
    expect(String(result.error?.message)).toBe('The AMQP broker refused the username or password');
    expect(JSON.stringify(result.error)).not.toContain('nope-secret');
  });
});

describe('credential test', () => {
  it('passes with the right password', async () => {
    const broker = await newBroker();
    expect(await amqpCredentialTest(testContext(), { type: 'amqp', data: broker.creds() })).toEqual({
      status: 'OK',
      message: 'Connection successful',
    });
  });

  it('fails clearly with a wrong password and never repeats it', async () => {
    const broker = await newBroker();
    const result = await amqpCredentialTest(testContext(), {
      type: 'amqp',
      data: broker.creds({ password: 'wrong-secret-word' }),
    });
    expect(result).toEqual({ status: 'Error', message: 'The AMQP broker refused the username or password' });
  });

  it('fails clearly when nothing listens, and when the host is refused by the guard', async () => {
    const broker = await newBroker();
    const creds = broker.creds();
    await broker.stop();
    const down = await amqpCredentialTest(testContext(), { type: 'amqp', data: creds });
    expect(down.status).toBe('Error');
    expect(down.message).toMatch(/^Couldn't connect to the AMQP broker/);
    const blocked = await amqpCredentialTest(testContext(new HttpClient()), { type: 'amqp', data: creds });
    expect(blocked.status).toBe('Error');
    expect(describeConnectError(new Error('Blocked'))).toBe("Couldn't connect to the AMQP broker");
    expect(blocked.message).not.toContain('password');
  });
});

describe('SSRF guard and TLS', () => {
  it('the default policy refuses loopback, and nothing connects', async () => {
    const broker = await newBroker();
    const h = harness({ sink: 'q', options: {} }, { creds: broker.creds(), httpClient: new HttpClient() });
    await expect(triggerType().trigger!(h.ctx)).rejects.toThrow();
    expect(broker.connections).toBe(0);
  });

  it('tcp: a name connects only through the checked address and never resolves again (DNS rebind)', async () => {
    const broker = await newBroker();
    const queue = unique('rebind-tcp');
    const http = new ScriptedGuard(() => pinnedLoopback());
    const lookup = vi.spyOn(dns, 'lookup');
    const { runs } = await start(
      broker,
      { sink: queue, options: {} },
      { httpClient: http, creds: broker.creds({ hostname: 'amqp.rebind.test' }) },
    );
    broker.put(queue, 'through the guard');
    await until(() => runs.length === 1);
    expect(http.checked).toEqual(['amqp.rebind.test']);
    expect(lookup.mock.calls.some(([host]) => host === 'amqp.rebind.test')).toBe(false);
  });

  it('tls: the same through a pinned address, with the name as the server name and the certificate checked', async () => {
    const broker = await newBroker(true);
    const queue = unique('rebind-tls');
    const http = new ScriptedGuard(() => pinnedLoopback());
    const lookup = vi.spyOn(dns, 'lookup');
    const { runs } = await start(
      broker,
      { sink: queue, options: {} },
      { httpClient: http, creds: broker.creds({ hostname: 'broker.test' }) },
    );
    broker.put(queue, 'secure');
    await until(() => runs.length === 1);
    expect(http.checked).toEqual(['broker.test']);
    expect(broker.servernames).toEqual(['broker.test']);
    expect(lookup.mock.calls.some(([host]) => host === 'broker.test')).toBe(false);
  });

  it('tls verifies the certificate: without the CA the credential test fails and does not say why in the broker text', async () => {
    const broker = await newBroker(true);
    const trusted = await amqpCredentialTest(testContext(), { type: 'amqp', data: broker.creds() });
    expect(trusted.status).toBe('OK');
    const result = await amqpCredentialTest(testContext(), {
      type: 'amqp',
      data: broker.creds({ ca: '' }),
    });
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/^Couldn't connect to the AMQP broker/);
  });

  it('tls refuses a CA field that is not a PEM block', async () => {
    const broker = await newBroker(true);
    const result = await amqpCredentialTest(testContext(), { type: 'amqp', data: broker.creds({ ca: 'junk' }) });
    expect(result).toEqual({ status: 'Error', message: 'The AMQP CA certificate is not a valid PEM block' });
  });

  it('a name the guard refuses opens no socket', async () => {
    const broker = await newBroker();
    const http = new ScriptedGuard(() => new Error('Blocked by the guard'));
    const h = harness({ sink: 'q', options: {} }, { creds: broker.creds({ hostname: 'blocked.test' }), httpClient: http });
    await expect(triggerType().trigger!(h.ctx)).rejects.toThrow('Blocked by the guard');
    expect(broker.connections).toBe(0);
  });
});
