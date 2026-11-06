/** Kafka node against the real test broker (TEST_KAFKA_BROKERS): what it sends is read back with a plain client. */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { HttpClient } from '@workflow/core';
import type { AllowedHost, DataObject, Item } from '@workflow/workflow';
import kafkajs from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { kafkaCredentialTest } from '../src/nodes/apps/kafka/client';
import {
  acksCode,
  buildHeaders,
  compressionCode,
  type ProduceSettings,
} from '../src/nodes/apps/kafka/produce';
import { runNode } from './harness';
import { localHttp } from './servers';

const { Kafka, logLevel } = kafkajs;

vi.setConfig({ hookTimeout: 60_000 });

const BROKERS = process.env.TEST_KAFKA_BROKERS ?? '127.0.0.1:9092';
const SASL_BROKERS = process.env.TEST_KAFKA_SASL_BROKERS ?? '127.0.0.1:9093';

const kafkaCredentials = { brokers: BROKERS, clientId: 'l18-node-test', ssl: false };

const client = new Kafka({ clientId: 'l18-node-side', brokers: [BROKERS], logLevel: logLevel.NOTHING });
const admin = client.admin();
const closers: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  await admin.connect();
});
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});
afterAll(async () => {
  await admin.disconnect();
});

const unique = (name: string) => `l18n-${name}-${randomUUID().slice(0, 8)}`;

async function newTopic(name: string) {
  const topic = unique(name);
  await admin.createTopics({
    waitForLeaders: false,
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
  });
  closers.push(() => admin.deleteTopics({ topics: [topic] }).catch(() => undefined));
  await vi.waitFor(() => admin.fetchTopicMetadata({ topics: [topic] }), { timeout: 30_000, interval: 100 });
  return topic;
}

interface Received {
  value: Buffer | null;
  key: string | null;
  headers: Record<string, string>;
}

/** read `count` messages from the start of a topic, with a client of the test's own */
async function receive(topic: string, count: number): Promise<Received[]> {
  const consumer = client.consumer({
    groupId: unique('reader'),
    retry: { retries: 3 },
  });
  const got: Received[] = [];
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        got.push({
          value: message.value,
          key: message.key?.toString() ?? null,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([name, value]) => [name, String(value)]),
          ),
        });
      },
    });
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(count), {
      timeout: 40_000,
      interval: 100,
    });
  } finally {
    await consumer.disconnect();
  }
  return got;
}

const nodeType = () => nodes.find((n) => n.description.name === 'app.kafka')!;

const send = (parameters: DataObject, input: Item[] = [{ json: { id: 1 } }], creds: DataObject = {}) =>
  runNode('app.kafka', parameters, input, {
    creds: { kafka: kafkaCredentials, ...creds },
    services: { http: localHttp() },
  });

describe('description', () => {
  it('has an action for each operation, the v2 fields and the credential test', () => {
    const { properties, credentials } = nodeType().description;
    const operation = properties.find((p) => p.name === 'operation');
    for (const option of (operation?.options ?? []) as Array<{ action?: string }>) {
      expect(option.action).toBeTruthy();
    }
    expect(properties.map((p) => p.name)).toEqual([
      'operation',
      'topic',
      'sendInputData',
      'message',
      'useSchemaRegistry',
      'schemaRegistryUrl',
      'eventName',
      'useKey',
      'key',
      'jsonParameters',
      'headerParametersUi',
      'headerParametersJson',
      'options',
    ]);
    const options = properties.find((p) => p.name === 'options')?.options as Array<{
      name: string;
      default: unknown;
      options?: Array<{ value: string }>;
    }>;
    expect(options.map((o) => o.name)).toEqual(['acks', 'compression', 'timeout']);
    expect(options.find((o) => o.name === 'compression')?.options?.map((o) => o.value)).toEqual([
      'none',
      'gzip',
      'lz4',
      'snappy',
      'zstd',
    ]);
    expect(options.find((o) => o.name === 'timeout')?.default).toBe(30000);
    expect(credentials?.[0]).toEqual({ name: 'kafka', required: true, testedBy: 'kafkaCredentialTest' });
    expect(nodeType().methods?.credentialTest?.kafkaCredentialTest).toBe(kafkaCredentialTest);
  });
});

describe('send', () => {
  it('sends the input item as a JSON message and returns where the broker put it', async () => {
    const topic = await newTopic('input');
    const run = await send({ topic }, [{ json: { id: 1, name: 'a' } }, { json: { id: 2 } }]);
    expect(run.status).toBe('success');
    expect(run.outputs[0]).toHaveLength(2);
    expect(run.outputs[0]![0]).toMatchObject({ topicName: topic, partition: 0, errorCode: 0 });
    expect(run.items[0]!.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
    expect(Number(run.outputs[0]![1]!.baseOffset)).toBe(Number(run.outputs[0]![0]!.baseOffset) + 1);
    const got = await receive(topic, 2);
    expect(got.map((m) => JSON.parse(m.value!.toString()))).toEqual([{ id: 1, name: 'a' }, { id: 2 }]);
  });

  it('sends the Message field when Send Input Data is off, with an expression per item', async () => {
    const topic = await newTopic('message');
    const run = await send({ topic, sendInputData: false, message: '={{ "hello " + $json.name }}' }, [
      { json: { name: 'x' } },
      { json: { name: 'y' } },
    ]);
    expect(run.status).toBe('success');
    const got = await receive(topic, 2);
    expect(got.map((m) => m.value!.toString())).toEqual(['hello x', 'hello y']);
  });

  it('sets the key and the headers from the list', async () => {
    const topic = await newTopic('keyheaders');
    await send({
      topic,
      useKey: true,
      key: 'order-7',
      headerParametersUi: {
        parameter: [
          { key: 'source', value: 'workflow' },
          { key: '', value: 'dropped' },
        ],
      },
    });
    const [message] = await receive(topic, 1);
    expect(message!.key).toBe('order-7');
    expect(message!.headers).toEqual({ source: 'workflow' });
  });

  it('sets the headers from JSON, as text', async () => {
    const topic = await newTopic('jsonheaders');
    await send({
      topic,
      jsonParameters: true,
      headerParametersJson: '{"a":"1","n":2,"o":{"x":true}}',
    });
    const [message] = await receive(topic, 1);
    expect(message!.headers).toEqual({ a: '1', n: '2', o: '{"x":true}' });
    expect(message!.key).toBeNull();
  });

  it.each(['none', 'gzip', 'lz4', 'snappy', 'zstd'])(
    'compression %s: the broker takes it and the value reads back',
    async (compression) => {
      const topic = await newTopic(`c-${compression}`);
      const big = { text: 'compress me '.repeat(200) };
      const run = await send({ topic, options: { compression, acks: true } }, [{ json: big }]);
      expect(run.status).toBe('success');
      const [message] = await receive(topic, 1);
      expect(JSON.parse(message!.value!.toString())).toEqual(big);
    },
  );

  it('sends to the topic of each item when the topic is an expression', async () => {
    const one = await newTopic('many-a');
    const two = await newTopic('many-b');
    const run = await send({ topic: '={{ $json.to }}' }, [
      { json: { to: one, n: 1 } },
      { json: { to: two, n: 2 } },
    ]);
    expect(run.status).toBe('success');
    expect(run.outputs[0]!.map((r) => r.topicName)).toEqual([one, two]);
    expect(JSON.parse((await receive(two, 1))[0]!.value!.toString())).toEqual({ to: two, n: 2 });
  });
});

describe('failures', () => {
  it('stops with a clear text for headers that are not an object', async () => {
    const topic = await newTopic('badheaders');
    const run = await send({ topic, jsonParameters: true, headerParametersJson: '[1]' });
    expect(run.status).toBe('error');
    expect(String((run.error as Error)?.message)).toContain('Headers (JSON) has to be an object');
  });

  it('stops with a clear text for a missing topic name', async () => {
    const run = await send({ topic: '' });
    expect(run.status).toBe('error');
    expect(String((run.error as Error)?.message)).toContain('Enter the name of a topic');
  });

  it('with continue on fail, an item that fails does not stop the others', async () => {
    const topic = await newTopic('continue');
    const run = await runNode(
      'app.kafka',
      { topic: '={{ $json.to }}' },
      [{ json: { to: '' } }, { json: { to: topic } }],
      {
        creds: { kafka: kafkaCredentials },
        services: { http: localHttp() },
        node: { onError: 'continueRegularOutput' },
      },
    );
    expect(run.outputs[0]![0]).toEqual({ error: 'Enter the name of a topic' });
    expect(run.outputs[0]![1]).toMatchObject({ topicName: topic });
  });

  it('refuses a broker the SSRF guard blocks, and says so without opening a socket', async () => {
    class Blocking extends HttpClient {
      override async resolveAllowedHost(host: string): Promise<AllowedHost> {
        throw new Error(`Request to ${host} is blocked`);
      }
    }
    const run = await runNode('app.kafka', { topic: 't' }, [{ json: {} }], {
      creds: { kafka: { brokers: 'broker.test:9092', ssl: false } },
      services: { http: new Blocking() },
    });
    expect(run.status).toBe('error');
    expect(String((run.error as Error)?.message)).toContain('broker.test is blocked');
  });

  it('a wrong password fails the run with no text of the server', async () => {
    const run = await runNode('app.kafka', { topic: 't', options: { timeout: 5000 } }, [{ json: {} }], {
      creds: {
        kafka: {
          brokers: SASL_BROKERS,
          ssl: false,
          authentication: true,
          username: 'workflow',
          password: 'not-the-password',
          saslMechanism: 'plain',
        },
      },
      services: { http: localHttp() },
    });
    expect(run.status).toBe('error');
    expect(JSON.stringify(run.error)).not.toContain('not-the-password');
  });
});

describe('Schema Registry', () => {
  const schema = JSON.stringify({
    type: 'record',
    name: 'Person',
    namespace: 'test',
    fields: [{ name: 'name', type: 'string' }],
  });

  async function registry() {
    const requests: Array<{ url?: string; auth?: string }> = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
      if (req.url?.startsWith('/subjects/person-value/versions/latest')) {
        res.end(JSON.stringify({ subject: 'person-value', version: 1, id: 7, schema }));
      } else if (req.url === '/schemas/ids/7') {
        res.end(JSON.stringify({ schema }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error_code: 40401, message: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests };
  }

  it('encodes the item with the latest schema of the event name, signed in with the credential', async () => {
    const reg = await registry();
    const topic = await newTopic('registry');
    const run = await send(
      { topic, useSchemaRegistry: true, eventName: 'person-value' },
      [{ json: { name: 'ada' } }],
      { schemaRegistryApi: { url: reg.url, authentication: 'basicAuth', username: 'u', password: 'p' } },
    );
    expect(run.status).toBe('success');
    const [message] = await receive(topic, 1);
    // magic byte 0, the schema id 7, then Avro: the length of the string (zigzag) and its bytes
    expect(message!.value!.subarray(0, 5)).toEqual(Buffer.from([0, 0, 0, 0, 7]));
    expect(message!.value!.subarray(5)).toEqual(Buffer.from([6, 0x61, 0x64, 0x61]));
    expect(reg.requests[0]?.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('encodes the Message field, which has to be JSON, with the URL field', async () => {
    const reg = await registry();
    const topic = await newTopic('registrymsg');
    const run = await send({
      topic,
      sendInputData: false,
      message: '{"name":"bo"}',
      useSchemaRegistry: true,
      schemaRegistryUrl: reg.url,
      eventName: 'person-value',
    });
    expect(run.status).toBe('success');
    const [message] = await receive(topic, 1);
    expect(message!.value!.subarray(5)).toEqual(Buffer.from([4, 0x62, 0x6f]));
  });

  it('needs an event name, and a blocked registry host fails the run', async () => {
    const reg = await registry();
    const topic = await newTopic('registrynoevent');
    const noName = await send({ topic, useSchemaRegistry: true, schemaRegistryUrl: reg.url });
    expect(String((noName.error as Error)?.message)).toContain('Enter the Event Name');

    class Blocking extends HttpClient {
      constructor() {
        super({ ssrf: { allow: ['127.0.0.1'] } });
      }
      override async resolveAllowedHost(host: string): Promise<AllowedHost> {
        if (host === 'registry.test') throw new Error('Request to registry.test is blocked');
        return super.resolveAllowedHost(host);
      }
    }
    const blocked = await runNode(
      'app.kafka',
      { topic, useSchemaRegistry: true, schemaRegistryUrl: 'http://registry.test:8081', eventName: 'x' },
      [{ json: {} }],
      { creds: { kafka: kafkaCredentials }, services: { http: new Blocking() } },
    );
    expect(blocked.status).toBe('error');
    expect(String((blocked.error as Error)?.message)).toContain('registry.test is blocked');
  });
});

describe('helpers', () => {
  const base: ProduceSettings = {
    topic: 't',
    sendInputData: true,
    message: '',
    useSchemaRegistry: false,
    schemaRegistryUrl: '',
    eventName: '',
    useKey: false,
    key: '',
    jsonHeaders: false,
    headersJson: '',
    headers: [],
  };

  it('maps compression names to the Kafka codes and rejects others', () => {
    expect(['none', 'gzip', 'snappy', 'lz4', 'zstd'].map(compressionCode)).toEqual([0, 1, 2, 3, 4]);
    expect(() => compressionCode('brotli')).toThrow('not supported');
  });

  it('acks true waits for all replicas, false for the leader', () => {
    expect([acksCode(true), acksCode(false)]).toEqual([-1, 1]);
  });

  it('builds no headers from nothing and rejects JSON that does not parse', () => {
    expect(buildHeaders(base)).toEqual({});
    expect(buildHeaders({ ...base, jsonHeaders: true, headersJson: '  ' })).toEqual({});
    expect(() => buildHeaders({ ...base, jsonHeaders: true, headersJson: '{' })).toThrow(
      'Headers (JSON) is not valid JSON',
    );
  });
});
