/**
 * What the RabbitMQ Trigger does with a message: the settings of the node, the item a run gets, and the
 * tracker that answers the broker (ack or nack) according to how the run it started went.
 */
import type {
  DataObject,
  Item,
  Logger,
  NodeHelpers,
  TriggerContext,
  TriggerRunResult,
  WebhookResponse,
} from '@workflow/workflow';
import type { ConsumeMessage, GetMessage } from 'amqplib';
import type { QueueSettings } from './connect';

/** the broker is told a message is done: it is removed from the queue */
export type AcknowledgeMode =
  | 'immediately'
  | 'executionFinishes'
  | 'executionFinishesSuccessfully'
  | 'laterMessageNode';

export const PARALLEL_LIMIT_ERROR =
  'Parallel message processing limit must be a number greater than zero (or -1 for no limit)';

export interface MessageOptions {
  contentIsBinary: boolean;
  jsonParseBody: boolean;
  onlyContent: boolean;
}

export interface TriggerSettings extends QueueSettings {
  acknowledge: AcknowledgeMode;
  /** unanswered messages the broker may hand out at once; 0 = no limit */
  prefetch: number;
  message: MessageOptions;
  manual: boolean;
}

const ACKNOWLEDGE_MODES: AcknowledgeMode[] = [
  'immediately',
  'executionFinishes',
  'executionFinishesSuccessfully',
  'laterMessageNode',
];

const isObject = (value: unknown): value is DataObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** the key/value rows of a fixedCollection, as the table the broker takes: 5 -> 5, true -> true */
export function keyValueTable(collection: unknown, rowsName: string): DataObject {
  const rows = isObject(collection) ? collection[rowsName] : undefined;
  const table: DataObject = {};
  if (!Array.isArray(rows)) return table;
  for (const row of rows) {
    if (!isObject(row)) continue;
    const key = String(row.key ?? '').trim();
    if (!key) continue;
    const raw = String(row.value ?? '');
    if (/^-?\d{1,15}$/.test(raw)) table[key] = Number(raw);
    else if (raw === 'true' || raw === 'false') table[key] = raw === 'true';
    else table[key] = raw;
  }
  return table;
}

export function readTriggerSettings(ctx: TriggerContext): TriggerSettings {
  const queue = String(ctx.getNodeParameter('queue', 0, '')).trim();
  if (!queue) throw new Error('Queue / Topic is required');
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const manual = ctx.getActivationMode() === 'manual';

  const chosen = ACKNOWLEDGE_MODES.includes(options.acknowledge as AcknowledgeMode)
    ? (options.acknowledge as AcknowledgeMode)
    : 'immediately';

  let limit = -1;
  if (options.parallelMessages !== undefined && options.parallelMessages !== '') {
    limit = Number(options.parallelMessages);
    if (!Number.isInteger(limit) || limit === 0 || limit < -1) throw new Error(PARALLEL_LIMIT_ERROR);
  }
  // a limit needs the run to end before the next message: it cannot work with an answer at once
  const acknowledge = chosen === 'immediately' && limit !== -1 ? 'executionFinishes' : chosen;

  const bindingRows = isObject(options.binding) ? options.binding.bindings : undefined;
  const bindings = (Array.isArray(bindingRows) ? bindingRows : [])
    .filter(isObject)
    .map((row) => ({
      exchange: String(row.exchange ?? '').trim(),
      routingKey: String(row.routingKey ?? ''),
    }))
    .filter((binding) => binding.exchange !== '');

  const binary = options.contentIsBinary === true;
  return {
    queue,
    assertQueue: options.assertQueue !== false,
    assertExchange: options.assertExchange !== false,
    durable: options.durable !== false,
    exclusive: options.exclusive === true,
    autoDelete: options.autoDelete === true,
    queueArguments: keyValueTable(options.arguments, 'argument'),
    bindings,
    bindingHeaders: keyValueTable(options.headers, 'header'),
    // a test run takes one message at a time and answers it at once
    acknowledge: manual ? 'immediately' : acknowledge,
    prefetch: manual ? 1 : limit === -1 ? 0 : limit,
    message: {
      contentIsBinary: binary,
      jsonParseBody: !binary && options.jsonParseBody === true,
      onlyContent: !binary && options.onlyContent === true,
    },
    manual,
  };
}

/** a value from the broker's tables as plain JSON: bytes as text, 64-bit numbers as numbers or text */
function plain(value: unknown): DataObject[string] {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain) as DataObject[string];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, plain(entry)]),
    );
  }
  return value as DataObject[string];
}

interface ParserContext {
  logger: Pick<Logger, 'warn'>;
  helpers: Pick<NodeHelpers, 'prepareBinaryData'>;
}

/** the item of a message: `{ content, fields, properties }`, or what the options leave of it */
export function createMessageParser(ctx: ParserContext, options: MessageOptions) {
  return async (message: ConsumeMessage | GetMessage): Promise<Item> => {
    const { fields, properties } = message;
    const envelope: DataObject = {
      fields: plain({
        consumerTag: 'consumerTag' in fields ? fields.consumerTag : undefined,
        deliveryTag: fields.deliveryTag,
        redelivered: fields.redelivered,
        exchange: fields.exchange,
        routingKey: fields.routingKey,
      }) as DataObject,
      properties: plain(properties) as DataObject,
    };

    if (options.contentIsBinary) {
      const mimeType = properties.contentType || 'application/octet-stream';
      return {
        json: { content: '', ...envelope },
        binary: { data: await ctx.helpers.prepareBinaryData(message.content, 'message', mimeType) },
      };
    }

    let content: unknown = message.content.toString('utf8');
    if (options.jsonParseBody) {
      try {
        content = JSON.parse(content as string);
      } catch {
        ctx.logger.warn('Could not parse the message body to JSON, returning it as text');
      }
    }
    if (options.onlyContent) {
      // an item body has to be an object
      return { json: isObject(content) ? content : { content: content as DataObject[string] } };
    }
    return { json: { content: content as DataObject[string], ...envelope } };
  };
}

/** what the tracker needs from a channel */
export interface AnswerChannel {
  ack(message: ConsumeMessage | GetMessage): void;
  nack(message: ConsumeMessage | GetMessage, allUpTo?: boolean, requeue?: boolean): void;
}

export interface TrackerDeps {
  channel: AnswerChannel;
  mode: AcknowledgeMode;
  parse(message: ConsumeMessage | GetMessage): Promise<Item>;
  emit: TriggerContext['emit'];
  logger: Pick<Logger, 'debug' | 'warn'>;
  /** how long a close waits for runs that are still going (default 10 seconds) */
  closeWaitMs?: number;
  /** how long a message of a run that could not start stays out of the queue (default 5 seconds) */
  retryDelayMs?: number;
}

export const CLOSE_WAIT_MS = 10_000;
export const RETRY_DELAY_MS = 5000;

const FAILED_STATUSES: ReadonlySet<TriggerRunResult['status']> = new Set(['error', 'crashed', 'canceled']);

/**
 * Starts a run per message and answers the broker once. A message the broker is never told about comes
 * back by itself when the channel closes, so an answer that cannot be sent (channel gone) is dropped.
 */
export function createTracker(deps: TrackerDeps) {
  const { channel, mode, logger } = deps;
  const pending = new Set<Promise<void>>();
  const retryWaits = new Set<() => void>();
  let stopped = false;

  /** without this a limit that stops every run would send the message round at the speed of the broker */
  function waitBeforeRetry(): Promise<void> {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        retryWaits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, deps.retryDelayMs ?? RETRY_DELAY_MS);
      retryWaits.add(finish);
    });
  }

  function answer(message: ConsumeMessage | GetMessage, how: 'ack' | 'requeue' | 'reject') {
    try {
      if (how === 'ack') channel.ack(message);
      else channel.nack(message, false, how === 'requeue');
    } catch {
      logger.debug('A RabbitMQ message could not be answered, the channel is closed');
    }
  }

  async function process(message: ConsumeMessage | GetMessage): Promise<void> {
    let item: Item;
    try {
      item = await deps.parse(message);
    } catch {
      // no answer, as in n8n: the broker keeps the message and hands it out again when the channel closes
      logger.warn('A RabbitMQ message could not be read, it stays with the broker until the channel closes');
      return;
    }

    if (mode === 'immediately') {
      answer(message, 'ack');
      deps.emit([[item]]);
      return;
    }

    let answered = false;
    const once = (how: 'ack' | 'requeue' | 'reject') => {
      if (answered) return;
      answered = true;
      answer(message, how);
    };
    const outcome = await new Promise<TriggerRunResult | Error>((resolve) => {
      deps.emit(
        [[item]],
        { resolve: (result) => resolve(result), reject: (error) => resolve(error) },
        // the node that deletes from the queue (or a response node) answers the broker
        mode === 'laterMessageNode' ? (_response: WebhookResponse) => once('ack') : undefined,
      );
    });

    if (outcome instanceof Error) {
      // no run took place: the message stays in the queue
      logger.warn('The run could not start, the message goes back to the queue');
      await waitBeforeRetry();
      once('requeue');
    } else if (mode === 'executionFinishes') {
      once('ack');
    } else if (outcome.error !== undefined || FAILED_STATUSES.has(outcome.status)) {
      once('requeue');
    } else {
      // also a run that waits at a Wait node: it has not failed, and a requeue would start it over and over
      once('ack');
    }
  }

  return {
    /** answer one message from the broker; never throws */
    handle(message: ConsumeMessage | GetMessage): Promise<void> {
      if (stopped) {
        answer(message, 'requeue');
        return Promise.resolve();
      }
      const work = process(message).catch((error: Error) => {
        logger.warn(`A RabbitMQ message failed: ${error.message}`);
        answer(message, 'requeue');
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return work;
    },
    /** no new message is taken from now on; one that arrives is returned to the queue */
    stop() {
      stopped = true;
      for (const finish of [...retryWaits]) finish();
    },
    inFlight: () => pending.size,
    /** wait for runs that are going, at most `closeWaitMs`; the broker redelivers what stays open */
    async drain(): Promise<void> {
      if (pending.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, deps.closeWaitMs ?? CLOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
