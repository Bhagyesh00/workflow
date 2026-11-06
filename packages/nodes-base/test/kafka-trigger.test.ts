/**
 * Kafka Trigger against the real test broker (TEST_KAFKA_BROKERS, TEST_KAFKA_SASL_BROKERS), plus the
 * consume logic on a fake consumer for what a broker cannot be made to do on demand.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createTriggerContext, HttpClient } from '@workflow/core';
import {
  type AllowedHost,
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type TriggerResponse,
  type TriggerRunResult,
  Workflow,
} from '@workflow/workflow';
import kafkajs from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { credentials as allCredentials, nodes } from '../src';
import { kafkaCredentialTest } from '../src/nodes/apps/kafka/client';
import { guardedSocketFactory, kafkaTlsOptions, openKafka } from '../src/nodes/apps/kafka/client';
import {
  compressLz4,
  compressSnappy,
  decompressLz4,
  decompressSnappy,
  decompressZstd,
} from '../src/nodes/apps/kafka/codecs';
import {
  consumerConfig,
  createTopicConsumer,
  mayAdvance,
  readTriggerSettings,
  testGroupId,
} from '../src/nodes/apps/kafka/consume';
import { scrubRegistryError } from '../src/nodes/apps/kafka/schema-registry';
import { node, nodeTypes, testServices } from './harness';
import { localHttp } from './servers';

const { CompressionTypes, Kafka, logLevel } = kafkajs;

vi.setConfig({ hookTimeout: 60_000 });

const BROKERS = process.env.TEST_KAFKA_BROKERS ?? '127.0.0.1:9092';
const SASL_BROKERS = process.env.TEST_KAFKA_SASL_BROKERS ?? '127.0.0.1:9093';
const PORT = Number(BROKERS.split(':')[1]);

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

const plainCredentials = { brokers: BROKERS, clientId: 'l18-test', ssl: false };
const saslCredentials = (password: string) => ({
  brokers: SASL_BROKERS,
  clientId: 'l18-test',
  ssl: false,
  authentication: true,
  username: 'workflow',
  password,
  saslMechanism: 'plain',
});

const client = new Kafka({ clientId: 'l18-test-side', brokers: [BROKERS], logLevel: logLevel.NOTHING });
const admin = client.admin();
const producer = client.producer();
const closers: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  await admin.connect();
  await producer.connect();
  await warmUpGroupCoordinator();
});

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

afterAll(async () => {
  await producer.disconnect();
  await admin.disconnect();
});

/** on a new broker the first group makes Kafka create its offsets topic, and joining fails until it is there */
async function warmUpGroupCoordinator() {
  const topic = await newTopic('warm');
  await vi.waitFor(
    async () => {
      const consumer = client.consumer({
        groupId: unique('warm'),
        retry: { retries: 1, restartOnFailure: async () => false },
      });
      try {
        const joined = new Promise<void>((resolve, reject) => {
          consumer.on(consumer.events.GROUP_JOIN, () => resolve());
          consumer.on(consumer.events.CRASH, ({ payload }) => reject(payload.error));
        });
        await consumer.connect();
        await consumer.subscribe({ topics: [topic] });
        await consumer.run({ eachMessage: async () => undefined });
        await joined;
      } finally {
        await consumer.disconnect();
      }
    },
    { timeout: 45_000, interval: 500 },
  );
}

const unique = (name: string) => `l18-${name}-${randomUUID().slice(0, 8)}`;

async function newTopic(name: string, configEntries: Array<{ name: string; value: string }> = []) {
  const topic = unique(name);
  await admin.createTopics({
    waitForLeaders: false,
    topics: [{ topic, numPartitions: 1, replicationFactor: 1, configEntries }],
  });
  closers.push(() => admin.deleteTopics({ topics: [topic] }).catch(() => undefined));
  await vi.waitFor(() => admin.fetchTopicMetadata({ topics: [topic] }), { timeout: 30_000, interval: 100 });
  return topic;
}

const send = (topic: string, ...values: Array<string | Buffer>) =>
  producer.send({ topic, messages: values.map((value) => ({ value })) });

async function committed(groupId: string, topic: string): Promise<string> {
  const [entry] = await admin.fetchOffsets({ groupId, topics: [topic] });
  return entry?.partitions[0]?.offset ?? '-1';
}

/** the run a trigger emitted, with the callbacks it passed */
interface EmittedRun {
  items: Item[];
  done?: { resolve(r: TriggerRunResult): void; reject(e: Error): void };
}

interface HarnessOptions {
  creds?: Record<string, DataObject>;
  httpClient?: HttpClient;
  mode?: 'activate' | 'manual';
  /** answer each run; without it runs are answered with `success` */
  onRun?: (run: EmittedRun, index: number) => void;
}

function harness(parameters: DataObject, options: HarnessOptions = {}) {
  const creds = options.creds ?? { kafka: plainCredentials };
  const logs: string[] = [];
  const record = (message: unknown, meta?: unknown) =>
    void logs.push(`${String(message)} ${meta === undefined ? '' : JSON.stringify(meta)}`);
  const logger = { debug: record, info: record, warn: record, error: record };
  const wfNode = node('Kafka Trigger', 'app.kafkaTrigger', parameters, [0, 0], {
    credentials: Object.fromEntries(Object.keys(creds).map((k) => [k, { id: k, name: k }])),
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

const nodeType = () => nodes.find((n) => n.description.name === 'app.kafkaTrigger')!;

/** run the node and close it after the test */
async function start(
  parameters: DataObject,
  options: HarnessOptions = {},
): Promise<ReturnType<typeof harness> & { response: TriggerResponse }> {
  const h = harness(parameters, options);
  const response = (await nodeType().trigger!(h.ctx)) as TriggerResponse;
  closers.push(() => response.closeFunction?.());
  return { ...h, response };
}

const until = (check: () => boolean | Promise<boolean>, timeout = 30_000) =>
  vi.waitFor(
    async () => {
      expect(await check()).toBe(true);
    },
    { timeout, interval: 50 },
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** a checked host that answers only with `address`, whatever DNS would say */
function pinned(address: string): AllowedHost {
  const family = net.isIP(address) as 4 | 6;
  return {
    addresses: [{ address, family }],
    lookup(_hostname, options, callback) {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  };
}

describe('description', () => {
  it('has the fields of n8n v2 with their defaults', () => {
    const { properties, credentials } = nodeType().description;
    const field = (name: string) => properties.find((p) => p.name === name);
    expect(field('topic')).toMatchObject({ required: true, default: '' });
    expect(field('groupId')).toMatchObject({ required: true, default: '' });
    expect(field('resolveOffset')?.default).toBe('onCompletion');
    expect(field('resolveOffset')?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'onCompletion',
      'onSuccess',
      'onStatus',
      'immediately',
    ]);
    expect(field('allowedStatuses')).toMatchObject({
      default: ['success'],
      displayOptions: { show: { resolveOffset: ['onStatus'] } },
    });
    expect(field('allowedStatuses')?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'canceled',
      'crashed',
      'error',
      'new',
      'running',
      'success',
      'unknown',
      'waiting',
    ]);
    expect(field('useSchemaRegistry')?.default).toBe(false);
    expect(field('schemaRegistryUrl')?.displayOptions).toEqual({ show: { useSchemaRegistry: [true] } });

    const options = new Map(
      (field('options')?.options as Array<{ name: string; default: unknown }>).map((o) => [o.name, o]),
    );
    const defaults = Object.fromEntries([...options].map(([name, o]) => [name, o.default]));
    expect(defaults).toEqual({
      autoCommitInterval: 0,
      batchSize: 1,
      fetchMaxBytes: 1048576,
      fetchMinBytes: 1,
      heartbeatInterval: 10000,
      maxInFlightRequests: 1,
      fromBeginning: true,
      jsonParseMessage: false,
      keepBinaryData: false,
      partitionsConsumedConcurrently: 0,
      onlyMessage: false,
      returnHeaders: false,
      rebalanceTimeout: 600000,
      errorRetryDelay: 5000,
      sessionTimeout: 30000,
    });
    expect(credentials).toEqual([
      { name: 'kafka', required: true, testedBy: 'kafkaCredentialTest' },
      {
        name: 'schemaRegistryApi',
        required: false,
        displayOptions: { show: { useSchemaRegistry: [true] } },
      },
    ]);
    expect(nodeType().methods?.credentialTest?.kafkaCredentialTest).toBe(kafkaCredentialTest);
  });

  it('the credentials have the fields of n8n', () => {
    const fields = (name: string) =>
      allCredentials.find((c) => c.name === name)?.properties.map((p) => p.name);
    expect(fields('kafka')).toEqual([
      'clientId',
      'brokers',
      'ssl',
      'ca',
      'cert',
      'key',
      'allowUnauthorizedCerts',
      'authentication',
      'username',
      'password',
      'saslMechanism',
    ]);
    expect(fields('schemaRegistryApi')).toEqual(['url', 'authentication', 'username', 'password']);
    const kafka = allCredentials.find((c) => c.name === 'kafka')!;
    const prop = (name: string) => kafka.properties.find((p) => p.name === name);
    expect(prop('ssl')?.default).toBe(true);
    expect(prop('allowUnauthorizedCerts')?.default).toBe(false);
    expect(prop('saslMechanism')?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'plain',
      'scram-sha-256',
      'scram-sha-512',
    ]);
    expect(prop('key')?.typeOptions?.password).toBe(true);
    expect(prop('password')?.typeOptions?.password).toBe(true);
  });
});

describe('consuming from the broker', () => {
  it('starts a run with the message and moves the group offset', async () => {
    const topic = await newTopic('run');
    const groupId = unique('group');
    await send(topic, 'first');
    const { runs } = await start({ topic, groupId });
    await until(() => runs.length === 1);
    expect(runs[0]!.items).toEqual([{ json: { message: 'first', topic } }]);
    await until(async () => (await committed(groupId, topic)) === '1');
  });

  it('a message sent after the start starts a run too', async () => {
    const topic = await newTopic('later');
    const { runs } = await start({ topic, groupId: unique('group') });
    await send(topic, 'later');
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json.message).toBe('later');
  });

  it('JSON Parse Message, Return Headers and Only Message shape the item', async () => {
    const topic = await newTopic('shape');
    await producer.send({
      topic,
      messages: [
        { value: '{"a":1}', headers: { one: 'x', many: ['y', 'z'] } },
        { value: 'not json' },
        { value: '5' },
      ],
    });
    const parsed = await start({
      topic,
      groupId: unique('group'),
      options: { jsonParseMessage: true, returnHeaders: true },
    });
    await until(() => parsed.runs.length === 3);
    expect(parsed.runs[0]!.items[0]!.json).toEqual({
      headers: { one: 'x', many: 'y,z' },
      message: { a: 1 },
      topic,
    });
    expect(parsed.runs[1]!.items[0]!.json).toEqual({ headers: {}, message: 'not json', topic });
    expect(parsed.logs.join()).toContain('Could not parse message to JSON');

    const only = await start({
      topic,
      groupId: unique('group'),
      options: { jsonParseMessage: true, onlyMessage: true },
    });
    await until(() => only.runs.length === 3);
    expect(only.runs[0]!.items[0]!.json).toEqual({ a: 1 });
    // an item body is an object: a value that is not one stays under `message`
    expect(only.runs[1]!.items[0]!.json).toEqual({ message: 'not json' });
    expect(only.runs[2]!.items[0]!.json).toEqual({ message: 5 });
  });

  it('Keep Message as Binary Data keeps the raw value', async () => {
    const topic = await newTopic('binary');
    const raw = Buffer.from([0, 1, 2, 250, 255]);
    await send(topic, raw);
    const { runs } = await start({
      topic,
      groupId: unique('group'),
      options: { keepBinaryData: true },
    });
    await until(() => runs.length === 1);
    const binary = runs[0]!.items[0]!.binary?.data;
    expect(binary?.mimeType).toBe('application/octet-stream');
    expect(Buffer.from(String(binary?.data), 'base64').equals(raw)).toBe(true);
    expect(runs[0]!.items[0]!.json.topic).toBe(topic);
  });

  it('Batch Size puts that many messages in one run', async () => {
    const topic = await newTopic('batch');
    await send(topic, 'a', 'b', 'c', 'd', 'e');
    const { runs } = await start({ topic, groupId: unique('group'), options: { batchSize: 2 } });
    await until(() => runs.reduce((sum, run) => sum + run.items.length, 0) === 5);
    expect(runs.map((run) => run.items.map((item) => item.json.message))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('Read Messages From Beginning off skips what is already there', async () => {
    const topic = await newTopic('latest');
    await send(topic, 'old');
    const { runs } = await start({
      topic,
      groupId: unique('group'),
      options: { fromBeginning: false },
    });
    await sleep(1500);
    await send(topic, 'new');
    await until(() => runs.length >= 1);
    expect(runs.map((run) => run.items[0]!.json.message)).toEqual(['new']);
  });

  it('a pattern topic consumes every matching topic and skips the existence check', async () => {
    const topic = await newTopic('pattern');
    await send(topic, 'matched');
    const { runs } = await start({ topic: `^${topic}$`, groupId: unique('group') });
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json).toEqual({ message: 'matched', topic });
  });

  it('refuses a topic that does not exist, with the text of n8n', async () => {
    const topic = unique('missing');
    const h = harness({ topic, groupId: unique('group') });
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(
      `Kafka topic "${topic}" does not exist. Create the topic on the broker, or correct the Topic field, then publish the workflow again.`,
    );
    expect((await admin.listTopics()).includes(topic)).toBe(false);
  });

  it('refuses an invalid topic name and an empty topic or group', async () => {
    const h = harness({ topic: 'not valid!', groupId: unique('group') });
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(
      'Kafka topic "not valid!" is not a valid Kafka topic name. Correct the Topic field, then publish the workflow again.',
    );
    await expect(nodeType().trigger!(harness({ topic: '', groupId: 'g' }).ctx)).rejects.toThrow('Topic');
    await expect(nodeType().trigger!(harness({ topic: 't', groupId: '' }).ctx)).rejects.toThrow('Group ID');
  });

  it('consumes over SASL', async () => {
    const topic = await newTopic('sasl');
    await send(topic, 'through sasl');
    const { runs } = await start(
      { topic, groupId: unique('group') },
      { creds: { kafka: saslCredentials('workflow') } },
    );
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json.message).toBe('through sasl');
  });

  it('a wrong password fails the activation', async () => {
    const topic = await newTopic('wrong');
    const h = harness({ topic, groupId: unique('group') }, { creds: { kafka: saslCredentials('nope') } });
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow();
    expect(h.runs).toEqual([]);
  });
});

describe('resolve offset', () => {
  const answers =
    (...statuses: TriggerRunResult['status'][]) =>
    (run: EmittedRun, index: number) => {
      run.done?.resolve({ executionId: `run-${index}`, status: statuses[index] ?? 'success' });
    };

  it('On Execution Completion moves on after a failed run', async () => {
    const topic = await newTopic('completion');
    const groupId = unique('group');
    await send(topic, 'm');
    const { runs } = await start({ topic, groupId }, { onRun: answers('error') });
    await until(async () => (await committed(groupId, topic)) === '1');
    await sleep(1200);
    expect(runs).toHaveLength(1);
  });

  it('On Execution Success redelivers after a failed run, once the retry delay has passed', async () => {
    const topic = await newTopic('success');
    const groupId = unique('group');
    await send(topic, 'm', 'next');
    const seen: number[] = [];
    const { runs, logs } = await start(
      { topic, groupId, resolveOffset: 'onSuccess', options: { errorRetryDelay: 1000 } },
      {
        onRun: (run, index) => {
          seen.push(Date.now());
          run.done?.resolve({ executionId: `run-${index}`, status: index === 0 ? 'error' : 'success' });
        },
      },
    );
    await until(() => runs.length === 3);
    expect(runs.map((run) => run.items[0]!.json.message)).toEqual(['m', 'm', 'next']);
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(950);
    await until(async () => (await committed(groupId, topic)) === '2');
    expect(logs.join()).toContain(
      'Execution status is not allowed for resolving offsets, current status: error',
    );
  });

  it('On Execution Success keeps the offset until a run succeeds', async () => {
    const topic = await newTopic('keeps');
    const groupId = unique('group');
    await send(topic, 'm');
    const { runs } = await start(
      { topic, groupId, resolveOffset: 'onSuccess', options: { errorRetryDelay: 1000 } },
      { onRun: answers('error', 'error', 'success') },
    );
    await until(() => runs.length === 2);
    expect(['-1', '0']).toContain(await committed(groupId, topic));
    await until(() => runs.length === 3);
    await until(async () => (await committed(groupId, topic)) === '1');
  });

  it('On Allowed Execution Statuses moves on only for a listed status', async () => {
    const topic = await newTopic('status');
    const groupId = unique('group');
    await send(topic, 'm');
    const { runs } = await start(
      {
        topic,
        groupId,
        resolveOffset: 'onStatus',
        allowedStatuses: ['canceled'],
        options: { errorRetryDelay: 1000 },
      },
      { onRun: answers('success', 'canceled') },
    );
    await until(() => runs.length === 2);
    await until(async () => (await committed(groupId, topic)) === '1');
  });

  it('On Allowed Execution Statuses needs a status', async () => {
    const topic = await newTopic('nostatus');
    const h = harness({
      topic,
      groupId: unique('group'),
      resolveOffset: 'onStatus',
      allowedStatuses: [],
    });
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(
      'At least one execution status must be selected to resolve offsets on selected statuses.',
    );
  });

  it('Immediately does not wait for the run', async () => {
    const topic = await newTopic('immediately');
    const groupId = unique('group');
    await send(topic, 'a', 'b');
    const { runs } = await start(
      { topic, groupId, resolveOffset: 'immediately' },
      { onRun: () => undefined },
    );
    await until(() => runs.length === 2);
    expect(runs[0]!.done).toBeUndefined();
    await until(async () => (await committed(groupId, topic)) === '2');
  });

  it('a run that could not start counts as a failure under every waiting mode', async () => {
    const topic = await newTopic('nostart');
    const groupId = unique('group');
    await send(topic, 'm');
    const { runs } = await start(
      { topic, groupId, options: { errorRetryDelay: 1000 } },
      {
        onRun: (run, index) => {
          if (index === 0) run.done?.reject(new Error('could not start'));
          else run.done?.resolve({ executionId: 'x', status: 'success' });
        },
      },
    );
    await until(() => runs.length === 2);
    await until(async () => (await committed(groupId, topic)) === '1');
  });

  it('mayAdvance follows the mode', () => {
    const result = (status: TriggerRunResult['status']): TriggerRunResult => ({ executionId: 'e', status });
    expect(mayAdvance('onCompletion', [], result('error'))).toBe(true);
    expect(mayAdvance('onSuccess', [], result('success'))).toBe(true);
    expect(mayAdvance('onSuccess', [], result('error'))).toBe(false);
    expect(mayAdvance('onStatus', ['error'], result('error'))).toBe(true);
    expect(mayAdvance('onStatus', ['error'], result('success'))).toBe(false);
  });
});

describe('test run', () => {
  it('uses its own group, waits for new messages and leaves the workflow group alone', async () => {
    const topic = await newTopic('manual');
    const groupId = unique('group');
    await send(topic, 'old');
    const { runs, response } = await start({ topic, groupId }, { mode: 'manual' });
    // the consumer starts only in manualTriggerFunction
    await sleep(200);
    expect(runs).toEqual([]);
    expect(response.manualTriggerFunction).toBeTypeOf('function');
    await response.manualTriggerFunction!();
    await sleep(1500);
    await send(topic, 'new');
    await until(() => runs.length >= 1);
    expect(runs[0]!.items[0]!.json.message).toBe('new');
    expect(runs[0]!.done).toBeUndefined();
    expect(await committed(groupId, topic)).toBe('-1');
    const { groups } = await admin.listGroups();
    expect(groups.some((g) => g.groupId.startsWith(`${groupId}-n8n-manual-`))).toBe(true);
  });

  it('the group is <group>-n8n-manual-<uuid>', () => {
    expect(testGroupId('g')).toMatch(/^g-n8n-manual-[0-9a-f-]{36}$/);
    expect(testGroupId('g')).not.toBe(testGroupId('g'));
  });

  it('a close during the start ends the start without an error', async () => {
    const topic = await newTopic('manualclose');
    const h = await start({ topic, groupId: unique('group') }, { mode: 'manual' });
    const starting = h.response.manualTriggerFunction!();
    await h.response.closeFunction!();
    await expect(starting).resolves.toBeUndefined();
  });
});

describe('closing', () => {
  it('releases a run still in flight; the offset stays and the next start gets the message again', async () => {
    const topic = await newTopic('close');
    const groupId = unique('group');
    await send(topic, 'm');
    const first = await start({ topic, groupId }, { onRun: () => undefined });
    await until(() => first.runs.length === 1);
    const before = Date.now();
    await first.response.closeFunction!();
    expect(Date.now() - before).toBeLessThan(10_000);
    expect(['-1', '0']).toContain(await committed(groupId, topic));

    const second = await start({ topic, groupId });
    await until(() => second.runs.length === 1);
    expect(second.runs[0]!.items[0]!.json.message).toBe('m');
  });
});

describe('consume logic on a fake consumer', () => {
  function fakeConsumer() {
    const handlers = new Map<string, (event: { payload: DataObject }) => void>();
    let runConfig: DataObject = {};
    const consumer = {
      events: { CRASH: 'crash', GROUP_JOIN: 'join' },
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (config: DataObject) => {
        runConfig = config;
        fire('join', {});
      }),
      seek: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      on(event: string, handler: (event: { payload: DataObject }) => void) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    const fire = (event: string, payload: DataObject) => handlers.get(event)?.({ payload });
    return { consumer, fire, config: () => runConfig };
  }

  const baseOptions = {
    topic: 't',
    fromBeginning: true,
    batchSize: 1,
    retryDelayMs: 1000,
    partitionsConsumedConcurrently: 0,
    autoCommitIntervalMs: 0,
    resolveOffset: 'onCompletion' as const,
    allowedStatuses: [],
    manual: false,
    heartbeatIntervalMs: 10_000,
    configuredGroupId: 'g',
  };

  function logic(
    fake: ReturnType<typeof fakeConsumer>,
    overrides: Partial<typeof baseOptions> & { closeTimeoutMs?: number } = {},
  ) {
    const errors: Error[] = [];
    const emitted: Item[][] = [];
    let restart: ((error: Error) => Promise<boolean>) | undefined;
    const controller = createTopicConsumer(
      {
        createConsumer: (restartOnFailure) => {
          restart = restartOnFailure;
          return fake.consumer as never;
        },
        parse: async (message) => ({ json: { message: String(message.value) } }),
        emit: (data, done) => {
          emitted.push(data[0]!);
          done?.resolve({ executionId: 'e', status: 'success' });
        },
        emitError: (error) => void errors.push(error),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        } as never,
      },
      { ...baseOptions, ...overrides },
    );
    return { controller, errors, emitted, restart: () => restart! };
  }

  it('a crash during the start fails the start and stops the restarts', async () => {
    const fake = fakeConsumer();
    fake.consumer.run.mockImplementation(async () => {
      fake.fire('crash', { error: new Error('broker said no') as never, restart: false });
    });
    const { controller, errors, restart } = logic(fake);
    await expect(controller.start()).rejects.toThrow('broker said no');
    expect(errors).toEqual([]);
    expect(fake.consumer.disconnect).toHaveBeenCalled();
    expect(await restart()(new Error('x'))).toBe(false);
  });

  it('a fatal crash after the start goes to emitError', async () => {
    const fake = fakeConsumer();
    const { controller, errors, restart } = logic(fake);
    await controller.start();
    expect(await restart()(new Error('x'))).toBe(true);
    fake.fire('crash', { error: new Error('lost it') as never, restart: true });
    expect(errors).toEqual([]);
    fake.fire('crash', { error: new Error('lost it') as never, restart: false });
    expect(errors.map((e) => e.message)).toEqual(['lost it']);
  });

  it('a crash caused by the close stays quiet', async () => {
    const fake = fakeConsumer();
    const { controller, errors } = logic(fake);
    await controller.start();
    await controller.close();
    fake.fire('crash', { error: new Error('closing') as never, restart: false });
    expect(errors).toEqual([]);
  });

  it('a test run refused its group says what to grant', async () => {
    const fake = fakeConsumer();
    fake.consumer.run.mockImplementation(async () => {
      fake.fire('crash', {
        error: Object.assign(new Error('Not authorized'), { type: 'GROUP_AUTHORIZATION_FAILED' }) as never,
        restart: false,
      });
    });
    const { controller } = logic(fake, { manual: true });
    const failure = await controller.start().catch((error: Error & { description?: string }) => error);
    expect((failure as Error).message).toBe('Kafka refused the consumer group used for a test run');
    expect((failure as { description?: string }).description).toContain('g-n8n-manual-');
  });

  it('a close that hangs is bounded', async () => {
    const fake = fakeConsumer();
    fake.consumer.disconnect.mockImplementation(() => new Promise(() => undefined));
    const { controller } = logic(fake, { closeTimeoutMs: 50 });
    await controller.start();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it('heartbeats while a run is in flight and commits each chunk', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const fake = fakeConsumer();
      let finish!: () => void;
      const controller = createTopicConsumer(
        {
          createConsumer: () => fake.consumer as never,
          parse: async () => ({ json: {} }),
          emit: (_data, done) => {
            finish = () => done?.resolve({ executionId: 'e', status: 'success' });
          },
          emitError: () => undefined,
          logger: { debug: () => undefined, warn: () => undefined } as never,
        },
        { ...baseOptions, heartbeatIntervalMs: 100 },
      );
      await controller.start();
      const heartbeat = vi.fn(async () => undefined);
      const commit = vi.fn(async () => undefined);
      const resolveOffset = vi.fn();
      const batch = (fake.config().eachBatch as (payload: unknown) => Promise<void>)({
        batch: { topic: 't', partition: 0, messages: [{ offset: '7', value: Buffer.from('x') }] },
        resolveOffset,
        heartbeat,
        commitOffsetsIfNecessary: commit,
        uncommittedOffsets: () => ({ topics: [] }),
        isRunning: () => true,
        isStale: () => false,
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(350);
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(resolveOffset).not.toHaveBeenCalled();
      finish();
      await batch;
      expect(resolveOffset).toHaveBeenCalledWith('7');
      expect(commit).toHaveBeenCalledWith({ topics: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns the options into the consumer settings, with the heartbeat clamped', () => {
    const h = harness({
      topic: 't',
      groupId: 'g',
      options: {
        sessionTimeout: 9000,
        heartbeatInterval: 10_000,
        rebalanceTimeout: 1234,
        fetchMaxBytes: 2048,
        fetchMinBytes: 2,
        maxInFlightRequests: 3,
        autoCommitInterval: 500,
        partitionsConsumedConcurrently: 4,
        errorRetryDelay: 10,
      },
    });
    const settings = readTriggerSettings(h.ctx);
    expect(settings.retryDelayMs).toBe(1000);
    const restartOnFailure = async () => true;
    expect(consumerConfig(settings, restartOnFailure)).toEqual({
      groupId: 'g',
      sessionTimeout: 9000,
      heartbeatInterval: 3000,
      rebalanceTimeout: 1234,
      maxBytes: 2048,
      maxBytesPerPartition: 2048,
      minBytes: 2,
      maxInFlightRequests: 3,
      allowAutoTopicCreation: false,
      retry: { retries: 5, restartOnFailure },
    });
    const lower = readTriggerSettings(harness({ topic: 't', groupId: 'g' }).ctx);
    expect(consumerConfig(lower, restartOnFailure).heartbeatInterval).toBe(10_000);
  });

  it('a test run has its own group and never reads from the beginning', () => {
    const settings = readTriggerSettings(
      harness({ topic: 't', groupId: 'g', options: { fromBeginning: true } }, { mode: 'manual' }).ctx,
    );
    expect(settings.groupId).toMatch(/^g-n8n-manual-/);
    expect(settings.fromBeginning).toBe(false);
    expect(settings.manual).toBe(true);
  });
});

describe('SSRF guard', () => {
  it('a blocked bootstrap host fails the activation at once', async () => {
    const topic = await newTopic('blocked');
    const h = harness({ topic, groupId: unique('group') }, { httpClient: new HttpClient() });
    const before = Date.now();
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(/blocked/);
    expect(Date.now() - before).toBeLessThan(1000);
  });

  it('connects to a name DNS does not know through the checked address (DNS rebind)', async () => {
    const topic = await newTopic('pinned');
    await send(topic, 'pinned');
    const guard = new ScriptedGuard(() => pinned('127.0.0.1'));
    const { runs } = await start(
      { topic, groupId: unique('group') },
      {
        httpClient: guard,
        creds: { kafka: { ...plainCredentials, brokers: `broker-rebind.test:${PORT}` } },
      },
    );
    await until(() => runs.length === 1);
    expect(guard.checked).toContain('broker-rebind.test');
    // and the broker it advertises went through the guard as well
    expect(guard.checked).toContain('127.0.0.1');
  });

  it('a broker that advertises a blocked host gets no connection', async () => {
    const topic = await newTopic('advertised');
    await send(topic, 'secret');
    const guard = new ScriptedGuard((host) =>
      host === 'bootstrap.test' ? pinned('127.0.0.1') : new Error(`Request to ${host} is blocked`),
    );
    const h = harness(
      { topic, groupId: unique('group') },
      {
        httpClient: guard,
        creds: { kafka: { ...plainCredentials, brokers: `bootstrap.test:${PORT}` } },
      },
    );
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow();
    expect(guard.checked).toContain('127.0.0.1');
    expect(h.runs).toEqual([]);
  });

  it('checks every socket: a name that rebinds to a blocked address opens nothing', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.end('hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;

    const answers: Array<AllowedHost | Error> = [pinned('127.0.0.1'), new Error('blocked now')];
    const helpers = {
      resolveAllowedHost: async () => {
        const answer = answers.shift()!;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const factory = guardedSocketFactory({ helpers: helpers as never });

    const received = await new Promise<string>((resolve, reject) => {
      const socket = factory.socketFactory({
        host: 'rebind.test',
        port,
        ssl: {},
        onConnect: () => undefined,
      });
      socket.on('data', (chunk) => resolve(chunk.toString()));
      socket.on('error', reject);
      closers.push(() => socket.destroy());
    });
    expect(received).toBe('hello');

    const refused = await new Promise<Error>((resolve) => {
      const socket = factory.socketFactory({
        host: 'rebind.test',
        port,
        ssl: {},
        onConnect: () => undefined,
      });
      socket.on('error', resolve);
    });
    expect(refused.message).toBe('blocked now');
    expect(connections).toBe(1);
  });

  it('TLS: verifies, sends the host as the server name, and only the field turns it off', async () => {
    let servername: unknown;
    const server = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
      servername = socket.servername;
      socket.end('secret hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    const helpers = { resolveAllowedHost: async () => pinned('127.0.0.1') };

    const attempt = (credentials: DataObject) =>
      new Promise<string>((resolve, reject) => {
        const factory = guardedSocketFactory({ helpers: helpers as never }, kafkaTlsOptions(credentials));
        const socket = factory.socketFactory({
          host: 'broker.test',
          port,
          ssl: {},
          onConnect: () => undefined,
        });
        socket.on('data', (chunk) => resolve(chunk.toString()));
        socket.on('error', reject);
        closers.push(() => socket.destroy());
      });

    await expect(attempt({ ssl: true })).rejects.toThrow(/self-signed|self signed/);
    expect(await attempt({ ssl: true, ca: CERT })).toBe('secret hello');
    expect(servername).toBe('broker.test');
    expect(await attempt({ ssl: true, allowUnauthorizedCerts: true })).toBe('secret hello');
  });

  it('a socket ended or destroyed before it connects leaves nothing open', async () => {
    let connections = 0;
    const server = net.createServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const helpers = {
      resolveAllowedHost: async () => {
        await gate;
        return pinned('127.0.0.1');
      },
    };
    const factory = guardedSocketFactory({ helpers: helpers as never });
    const socket = factory.socketFactory({ host: 'x.test', port, ssl: {}, onConnect: () => undefined });
    socket.on('error', () => undefined);
    socket.end();
    socket.unref();
    release();
    await until(() => socket.destroyed);
    await sleep(100);
    // the guarded connect may have reached the server, but the socket did not stay open
    expect(connections).toBeLessThanOrEqual(1);
    expect(factory.open()).toBe(0);
  });

  it('closing the client destroys what is still open', async () => {
    const accepted = new Set<net.Socket>();
    const server = net.createServer((socket) => void accepted.add(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => {
      for (const socket of accepted) socket.destroy();
      server.close();
    });
    const port = (server.address() as net.AddressInfo).port;
    const helpers = { resolveAllowedHost: async () => pinned('127.0.0.1') };
    const factory = guardedSocketFactory({ helpers: helpers as never });
    const connected = new Promise<void>((resolve) => {
      factory.socketFactory({ host: 'x.test', port, ssl: {}, onConnect: () => resolve() });
    });
    await connected;
    expect(factory.open()).toBe(1);
    factory.destroyAll();
    await until(() => factory.open() === 0);
  });
});

describe('credential checks', () => {
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
    kafkaCredentialTest(testContext(httpClient), { type: 'kafka', data });

  it('passes with the right password', async () => {
    expect(await run(saslCredentials('workflow'))).toEqual({
      status: 'OK',
      message: 'Connection successful',
    });
  });

  it('fails clearly on a wrong password, with no text of the server', async () => {
    const result = await run(saslCredentials('wrong-secret-password'));
    expect(result).toEqual({ status: 'Error', message: 'Kafka refused the username or password' });
  });

  it('fails clearly when nothing listens', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await run({ ...plainCredentials, brokers: `127.0.0.1:${port}` });
    expect(result).toEqual({ status: 'Error', message: "Couldn't connect to the Kafka brokers" });
  });

  it('fails on a blocked host', async () => {
    const result = await run(plainCredentials, new HttpClient());
    expect(result.status).toBe('Error');
    expect(result.message).toMatch(/blocked/);
  });

  it('has the texts of n8n for an incomplete credential', async () => {
    expect((await run({ ...plainCredentials, authentication: true, username: 'u' })).message).toBe(
      'Username and password are required for authentication',
    );
    expect((await run({ ...plainCredentials, ssl: true, cert: CERT })).message).toBe(
      'Kafka mTLS needs both a client certificate and a client private key',
    );
    expect((await run({ ...plainCredentials, ssl: true, ca: 'not pem' })).message).toBe(
      'The Kafka CA certificate is not a valid PEM block',
    );
    expect((await run({ ...plainCredentials, brokers: ' , ' })).message).toBe('Enter at least one broker');
    expect((await run({ ...plainCredentials, brokers: 'no-port' })).message).toBe(
      'Broker "no-port" needs the form host:port',
    );
  });

  it('TLS options: nothing when SSL is off, verification on by default', () => {
    expect(kafkaTlsOptions({ ssl: false, ca: CERT })).toBeUndefined();
    expect(kafkaTlsOptions({ ssl: true })).toEqual({});
    expect(kafkaTlsOptions({ ssl: true, allowUnauthorizedCerts: true })).toEqual({
      rejectUnauthorized: false,
    });
    expect(kafkaTlsOptions({ ssl: true, ca: CERT, cert: CERT, key: KEY })).toMatchObject({
      ca: CERT,
      cert: CERT,
    });
  });

  it('openKafka refuses before connecting', async () => {
    await expect(
      openKafka(
        { helpers: { resolveAllowedHost: vi.fn() } as never, logger: {} as never },
        {
          brokers: '',
        },
      ),
    ).rejects.toThrow('Enter at least one broker');
  });
});

describe('Schema Registry', () => {
  const avroSchema = JSON.stringify({
    type: 'record',
    name: 'Person',
    namespace: 'test',
    fields: [{ name: 'name', type: 'string' }],
  });
  const jsonSchema = JSON.stringify({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  });
  const protoSchema = 'syntax = "proto3"; package test; message Person { string name = 1; }';

  const wire = (id: number, payload: Buffer) => {
    const head = Buffer.alloc(5);
    head.writeInt32BE(id, 1);
    return Buffer.concat([head, payload]);
  };
  const avro = (name: string) => {
    const bytes = Buffer.from(name);
    // a short string: zigzag length, then the text
    return wire(1, Buffer.concat([Buffer.from([bytes.length * 2]), bytes]));
  };
  const json = (value: unknown) => wire(2, Buffer.from(JSON.stringify(value)));
  const proto = (name: string) => {
    const bytes = Buffer.from(name);
    return wire(3, Buffer.concat([Buffer.from([0, 0x0a, bytes.length]), bytes]));
  };

  async function registry(options: { failFirst?: number } = {}) {
    const requests: Array<{ url?: string; auth?: string }> = [];
    let failures = options.failFirst ?? 0;
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (failures > 0) {
        failures -= 1;
        res.writeHead(500, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
        res.end(JSON.stringify({ error_code: 50001, message: 'broken' }));
        return;
      }
      const id = Number(req.url?.split('/').pop());
      const answer =
        id === 1
          ? { schema: avroSchema }
          : id === 2
            ? { schema: jsonSchema, schemaType: 'JSON' }
            : { schema: protoSchema, schemaType: 'PROTOBUF' };
      res.writeHead(200, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests };
  }

  it('decodes Avro, JSON Schema and Protobuf, with the credential', async () => {
    const reg = await registry();
    const topic = await newTopic('registry');
    await send(topic, avro('avro'), json({ name: 'json' }), proto('proto'));
    const { runs } = await start(
      { topic, groupId: unique('group'), useSchemaRegistry: true },
      {
        creds: {
          kafka: plainCredentials,
          schemaRegistryApi: { url: reg.url, authentication: 'basicAuth', username: 'u', password: 'p' },
        },
      },
    );
    await until(() => runs.length === 3);
    expect(runs.map((run) => run.items[0]!.json.message)).toEqual([
      { name: 'avro' },
      { name: 'json' },
      expect.objectContaining({ name: 'proto' }),
    ]);
    expect(reg.requests[0]?.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('uses the URL field when no credential is chosen, and moves userinfo out of the URL', async () => {
    const reg = await registry();
    const topic = await newTopic('registryurl');
    await send(topic, json({ name: 'x' }));
    const { runs } = await start({
      topic,
      groupId: unique('group'),
      useSchemaRegistry: true,
      schemaRegistryUrl: reg.url.replace('http://', 'http://user:pass@'),
    });
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json.message).toEqual({ name: 'x' });
    expect(reg.requests[0]?.auth).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('leaves a message it cannot decode unread and retries, with the password out of the logs', async () => {
    const reg = await registry({ failFirst: 4 });
    const topic = await newTopic('registryfail');
    const groupId = unique('group');
    await send(topic, json({ name: 'late' }));
    const { runs, logs } = await start({
      topic,
      groupId,
      useSchemaRegistry: true,
      schemaRegistryUrl: reg.url.replace('http://', 'http://user:hunter2@'),
      options: { errorRetryDelay: 1000 },
    });
    await until(() => logs.join().includes('Could not decode message with Schema Registry'));
    expect(runs).toEqual([]);
    expect(['-1', '0']).toContain(await committed(groupId, topic));
    await until(() => runs.length === 1);
    expect(runs[0]!.items[0]!.json.message).toEqual({ name: 'late' });
    expect(logs.join()).not.toContain('hunter2');
  });

  it('a blocked registry host fails the activation', async () => {
    const topic = await newTopic('registryblocked');
    const guard = new ScriptedGuard((host) =>
      host === 'registry.test' ? new Error('Request to registry.test is blocked') : pinned('127.0.0.1'),
    );
    const h = harness(
      {
        topic,
        groupId: unique('group'),
        useSchemaRegistry: true,
        schemaRegistryUrl: 'http://registry.test:8081',
      },
      { httpClient: guard },
    );
    await expect(nodeType().trigger!(h.ctx)).rejects.toThrow(/blocked/);
  });

  it('every connection of the registry client goes to the checked address', async () => {
    const reg = await registry();
    const topic = await newTopic('registrypinned');
    await send(topic, json({ name: 'pinned' }));
    const guard = new ScriptedGuard(() => pinned('127.0.0.1'));
    const { runs } = await start(
      {
        topic,
        groupId: unique('group'),
        useSchemaRegistry: true,
        schemaRegistryUrl: reg.url.replace('127.0.0.1', 'registry-rebind.test'),
      },
      { httpClient: guard },
    );
    await until(() => runs.length === 1);
    expect(guard.checked).toContain('registry-rebind.test');
  });

  it('has the texts of n8n for a bad configuration', async () => {
    const topic = await newTopic('registrytexts');
    const fails = (parameters: DataObject, creds?: Record<string, DataObject>) =>
      nodeType().trigger!(
        harness({ topic, groupId: unique('group'), useSchemaRegistry: true, ...parameters }, { creds }).ctx,
      );
    await expect(fails({})).rejects.toThrow(
      'Select a Schema Registry credential or enter a Schema Registry URL',
    );
    await expect(fails({ schemaRegistryUrl: 'not a url' })).rejects.toThrow(
      'Verify your Schema Registry configuration',
    );
    await expect(fails({ schemaRegistryUrl: 'ftp://x.test' })).rejects.toThrow(
      'Verify your Schema Registry configuration',
    );
    await expect(
      fails(
        {},
        {
          kafka: plainCredentials,
          schemaRegistryApi: {
            url: 'http://x.test',
            authentication: 'basicAuth',
            username: '',
            password: '',
          },
        },
      ),
    ).rejects.toThrow('Username and password are required for Schema Registry Basic Auth');
  });

  it('scrubs userinfo and caps the length of a registry error', () => {
    expect(scrubRegistryError(new Error('GET http://user:p@ss@host/x failed'))).toBe(
      'GET http://***@host/x failed',
    );
    expect(scrubRegistryError(new Error('x'.repeat(2000))).length).toBeLessThanOrEqual(503);
  });
});

describe('compression', () => {
  // long enough for several blocks of every codec, with a part that does not compress
  const noise = Buffer.alloc(300_000);
  for (let i = 0, seed = 7; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = seed >> 16;
  }
  const big = Buffer.concat([Buffer.from('abc'.repeat(100_000)), noise]).toString('base64');

  it.each([
    ['snappy', CompressionTypes.Snappy],
    ['lz4', CompressionTypes.LZ4],
    ['zstd', CompressionTypes.ZSTD],
    ['gzip', CompressionTypes.GZIP],
  ])('%s: what we compress the broker takes, and we read it back', async (name, compression) => {
    const topic = await newTopic(`codec-${name}`);
    await producer.send({
      topic,
      compression,
      messages: [{ value: 'short' }, { value: big }],
    });
    const { runs } = await start({ topic, groupId: unique('group') });
    await until(() => runs.length === 2);
    expect(runs[0]!.items[0]!.json.message).toBe('short');
    expect(runs[1]!.items[0]!.json.message).toBe(big);
  });

  it.each([['snappy'], ['lz4'], ['zstd']])(
    '%s: reads what the broker itself compressed (the framing of the Java client)',
    async (name) => {
      const topic = await newTopic(`broker-${name}`, [{ name: 'compression.type', value: name }]);
      await producer.send({ topic, messages: [{ value: 'short' }, { value: big }] });
      const { runs } = await start({ topic, groupId: unique('group') });
      await until(() => runs.length === 2);
      expect(runs[0]!.items[0]!.json.message).toBe('short');
      expect(runs[1]!.items[0]!.json.message).toBe(big);
    },
  );

  it('snappy uses the xerial framing and also reads a bare block', () => {
    const framed = compressSnappy(Buffer.from('hello hello hello'));
    expect(framed.subarray(0, 8)).toEqual(Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]));
    expect(framed.readInt32BE(8)).toBe(1);
    expect(framed.readInt32BE(12)).toBe(1);
    expect(decompressSnappy(framed).toString()).toBe('hello hello hello');
    const bareBlock = Buffer.from([5, 16, 104, 101, 108, 108, 111]);
    expect(decompressSnappy(bareBlock).toString()).toBe('hello');
  });

  it('lz4 frames declare independent blocks, as the Kafka reader demands', () => {
    const frame = compressLz4(Buffer.from('x'.repeat(200_000)));
    expect(frame.readUInt32LE(0)).toBe(0x184d2204);
    // FLG: version 01 and the block independence bit
    expect(frame[4]! & 0xe0).toBe(0x60);
    expect(decompressLz4(frame).toString()).toBe('x'.repeat(200_000));
    expect(decompressLz4(compressLz4(Buffer.alloc(0))).length).toBe(0);
  });

  it('zstd reads a frame that does not declare its size, past the first buffer', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 'y');
    const blocks: Buffer[] = [];
    const blockSize = 128 * 1024;
    for (let offset = 0; offset < payload.length; offset += blockSize) {
      const part = payload.subarray(offset, offset + blockSize);
      const last = offset + blockSize >= payload.length ? 1 : 0;
      // block header: raw block, three bytes little endian
      const header = (part.length << 3) | last;
      blocks.push(Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), part);
    }
    // magic, no content size, a window of 8 MiB
    const frame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x68]), ...blocks]);
    expect((await decompressZstd(frame)).equals(payload)).toBe(true);
  });
});
