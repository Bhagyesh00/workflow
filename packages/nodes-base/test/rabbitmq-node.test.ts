/** P4-26 RabbitMQ node against the real test broker (TEST_RABBITMQ_URL): send to queue and exchange, delete from queue. */
import { randomUUID } from 'node:crypto';
import { type Channel, type ChannelModel, connect } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { runNode } from './harness';
import { localHttp } from './servers';

vi.setConfig({ hookTimeout: 60_000 });

const BROKER = new URL(process.env.TEST_RABBITMQ_URL ?? 'amqp://workflow:workflow@127.0.0.1:5672');
const creds = {
  hostname: BROKER.hostname,
  port: Number(BROKER.port || 5672),
  username: decodeURIComponent(BROKER.username),
  password: decodeURIComponent(BROKER.password),
  vhost: '/',
  ssl: false,
};
const unique = (name: string) => `l19n-${name}-${randomUUID().slice(0, 8)}`;

let direct: ChannelModel;
let channel: Channel;
const queues: string[] = [];
const exchanges: string[] = [];
beforeAll(async () => {
  direct = await connect(BROKER.href);
  channel = await direct.createChannel();
});
afterAll(async () => {
  for (const q of queues) await channel.deleteQueue(q).catch(() => undefined);
  for (const e of exchanges) await channel.deleteExchange(e).catch(() => undefined);
  await direct.close().catch(() => undefined);
});

const run = (
  parameters: Record<string, unknown>,
  input: Array<{ json: Record<string, unknown> }> = [{ json: { a: 1 } }],
  extra: { continueOnFail?: boolean; sendResponse?: () => void; creds?: Record<string, unknown> } = {},
) =>
  runNode('app.rabbitmq', parameters as never, input as never, {
    creds: { rabbitmq: (extra.creds ?? creds) as never },
    node: extra.continueOnFail ? { onError: 'continueRegularOutput' } : {},
    services: {
      http: localHttp(),
      ...(extra.sendResponse ? { hooks: { sendResponse: extra.sendResponse } } : {}),
    },
  });

const take = async (queue: string) => {
  const message = await channel.get(queue, { noAck: true });
  return message === false ? undefined : message;
};

describe('RabbitMQ node', () => {
  it('has both operations, each with an action', () => {
    const type = nodes.find((n) => n.description.name === 'app.rabbitmq')!;
    const operation = type.description.properties.find((p) => p.name === 'operation')!;
    const options = operation.options as Array<{ value: string; action?: string }>;
    expect(options.map((o) => o.value).sort()).toEqual(['deleteMessage', 'sendMessage']);
    for (const o of options) expect(o.action).toBeTruthy();
    expect(type.description.credentials?.[0]?.testedBy).toBe('rabbitmqCredentialTest');
  });

  it('sends the input items as JSON to a queue, one message per item, and passes them on', async () => {
    const queue = unique('q');
    queues.push(queue);
    const result = await run({ operation: 'sendMessage', mode: 'queue', queue }, [
      { json: { n: 1 } },
      { json: { n: 2 } },
    ]);
    expect(result.status).toBe('success');
    expect(result.outputs[0]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(JSON.parse((await take(queue))!.content.toString())).toEqual({ n: 1 });
    expect(JSON.parse((await take(queue))!.content.toString())).toEqual({ n: 2 });
    expect(await take(queue)).toBeUndefined();
  });

  it('sends a fixed message with headers, and declares a queue with arguments', async () => {
    const queue = unique('qh');
    queues.push(queue);
    const result = await run({
      operation: 'sendMessage',
      mode: 'queue',
      queue,
      sendInputData: false,
      message: 'plain text',
      headers: {
        header: [
          { key: 'tenant', value: 'acme' },
          { key: 'n', value: '5' },
        ],
      },
      options: { arguments: { argument: [{ key: 'x-message-ttl', value: '60000' }] } },
    });
    expect(result.status).toBe('success');
    const message = (await take(queue))!;
    expect(message.content.toString()).toBe('plain text');
    expect(message.properties.headers).toMatchObject({ tenant: 'acme', n: 5 });
    // the queue got the argument: declaring it again without it is refused
    const other = await direct.createChannel();
    other.on('error', () => undefined);
    await expect(other.assertQueue(queue, { durable: true })).rejects.toThrow();
  });

  it('publishes to an exchange with a routing key (direct) and reaches the bound queue', async () => {
    const exchange = unique('x');
    const queue = unique('qx');
    exchanges.push(exchange);
    queues.push(queue);
    await channel.assertExchange(exchange, 'direct', { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, 'blue');
    const result = await run({
      operation: 'sendMessage',
      mode: 'exchange',
      exchange,
      exchangeType: 'direct',
      routingKey: 'blue',
    });
    expect(result.status).toBe('success');
    const message = (await take(queue))!;
    expect(message.fields.routingKey).toBe('blue');
    expect(JSON.parse(message.content.toString())).toEqual({ a: 1 });
    await run({
      operation: 'sendMessage',
      mode: 'exchange',
      exchange,
      exchangeType: 'direct',
      routingKey: 'red',
    });
    expect(await take(queue)).toBeUndefined();
  });

  it('declares a missing fanout exchange', async () => {
    const exchange = unique('xf');
    exchanges.push(exchange);
    const result = await run({
      operation: 'sendMessage',
      mode: 'exchange',
      exchange,
      exchangeType: 'fanout',
    });
    expect(result.status).toBe('success');
    const probe = await direct.createChannel();
    await expect(probe.checkExchange(exchange)).resolves.toBeDefined();
    await probe.close();
  });

  it('fails on an empty queue or exchange name with a plain text', async () => {
    const noQueue = await run({ operation: 'sendMessage', mode: 'queue', queue: ' ' });
    expect(noQueue.status).toBe('error');
    expect(noQueue.error?.message).toContain('Queue / Topic is required');
    const noExchange = await run({ operation: 'sendMessage', mode: 'exchange', exchange: '' });
    expect(noExchange.error?.message).toContain('Exchange is required');
  });

  it('turns a refused queue declaration into a short fixed text, and continues on fail', async () => {
    const queue = unique('qd');
    queues.push(queue);
    await channel.assertQueue(queue, { durable: true });
    const failed = await run({ operation: 'sendMessage', mode: 'queue', queue, options: { durable: false } });
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toMatch(/^Couldn't send the RabbitMQ message: /);
    expect(failed.error?.message).not.toContain('\n');
    const kept = await run(
      { operation: 'sendMessage', mode: 'queue', queue, options: { durable: false } },
      [{ json: { a: 1 } }, { json: { a: 2 } }],
      { continueOnFail: true },
    );
    expect(kept.status).toBe('success');
    expect(kept.outputs[0]).toHaveLength(2);
    expect(kept.outputs[0]![0]).toHaveProperty('error');
    // the second item got a fresh channel and fails for the same reason, not because the channel was closed
    expect(String(kept.outputs[0]![1]!.error)).toBe(String(kept.outputs[0]![0]!.error));
  });

  it('keeps the broker password out of the error when the sign-in fails', async () => {
    const result = await run(
      { operation: 'sendMessage', mode: 'queue', queue: unique('qw') },
      [{ json: {} }],
      { creds: { ...creds, password: 'wrong-secret-pw' } },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('RabbitMQ refused the username or password');
    expect(JSON.stringify(result.error)).not.toContain('wrong-secret-pw');
  });

  it('delete from queue answers the trigger hook once and passes the items on', async () => {
    const sendResponse = vi.fn();
    const result = await run({ operation: 'deleteMessage' }, [{ json: { m: 1 } }, { json: { m: 2 } }], {
      sendResponse,
    });
    expect(result.status).toBe('success');
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(result.outputs[0]).toEqual([{ m: 1 }, { m: 2 }]);
  });

  it('delete from queue opens no connection (works without a reachable broker)', async () => {
    const result = await run({ operation: 'deleteMessage' }, [{ json: {} }], {
      creds: { ...creds, port: 1 },
      sendResponse: vi.fn(),
    });
    expect(result.status).toBe('success');
  });
});
