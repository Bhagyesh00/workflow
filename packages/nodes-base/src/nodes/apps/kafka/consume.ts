/**
 * The consume loop: read the settings, hand each chunk to a run, and resolve its offset by the mode the
 * user picked. A chunk that may not advance stays unread: after the retry delay the consumer seeks back
 * to it and Kafka delivers it again (at least once). Immediately never waits (at most once).
 */
import { randomUUID } from 'node:crypto';
import {
  type DataObject,
  type Item,
  type Logger,
  type TriggerContext,
  type TriggerRunResult,
  WorkflowError,
} from '@workflow/workflow';
import type { Consumer, ConsumerConfig, EachBatchPayload, KafkaMessage } from 'kafkajs';
import type { MessageOptions } from './message';

export type ResolveOffsetMode = 'onCompletion' | 'onSuccess' | 'onStatus' | 'immediately';

const MIN_RETRY_DELAY_MS = 1000;
const CONSUMER_RETRIES = 5;
/** below the 10 seconds the runtime gives a closer */
const CLOSE_TIMEOUT_MS = 8000;

export interface ConsumeOptions {
  topic: string;
  /** the group the user typed; a test run consumes under its own */
  configuredGroupId: string;
  fromBeginning: boolean;
  batchSize: number;
  retryDelayMs: number;
  partitionsConsumedConcurrently: number;
  autoCommitIntervalMs: number;
  resolveOffset: ResolveOffsetMode;
  allowedStatuses: string[];
  manual: boolean;
  heartbeatIntervalMs: number;
  closeTimeoutMs?: number;
}

export interface TriggerSettings extends ConsumeOptions {
  groupId: string;
  useSchemaRegistry: boolean;
  schemaRegistryUrl: string;
  sessionTimeoutMs: number;
  rebalanceTimeoutMs: number;
  fetchMaxBytes: number;
  fetchMinBytes: number;
  maxInFlightRequests: number;
  parser: MessageOptions;
}

/** a throwaway group, so a test run never marks messages read for the live workflow */
export function testGroupId(groupId: string): string {
  return `${testGroupPrefix(groupId)}${randomUUID()}`;
}

const testGroupPrefix = (groupId: string) => `${groupId}-n8n-manual-`;

function numberOption(value: unknown, fallback: number, minimum = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && value !== '' && value !== null && number >= minimum ? number : fallback;
}

export function readTriggerSettings(ctx: TriggerContext): TriggerSettings {
  const topic = String(ctx.getNodeParameter('topic', 0, '')).trim();
  const configuredGroupId = String(ctx.getNodeParameter('groupId', 0, '')).trim();
  if (!topic) throw new Error('Topic is required');
  if (!configuredGroupId) throw new Error('Group ID is required');

  const resolveOffset = ctx.getNodeParameter('resolveOffset', 0, 'onCompletion') as ResolveOffsetMode;
  const allowedStatuses = ctx.getNodeParameter('allowedStatuses', 0, ['success']) as string[];
  if (resolveOffset === 'onStatus' && allowedStatuses.length === 0) {
    throw new Error(
      'At least one execution status must be selected to resolve offsets on selected statuses.',
    );
  }

  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  const manual = ctx.getActivationMode() === 'manual';
  const sessionTimeoutMs = numberOption(options.sessionTimeout, 30_000, 1);
  return {
    topic,
    configuredGroupId,
    groupId: manual ? testGroupId(configuredGroupId) : configuredGroupId,
    manual,
    resolveOffset,
    allowedStatuses,
    useSchemaRegistry: ctx.getNodeParameter('useSchemaRegistry', 0, false) === true,
    schemaRegistryUrl: String(ctx.getNodeParameter('schemaRegistryUrl', 0, '')),
    // a test run has only the messages sent while it listens
    fromBeginning: !manual && options.fromBeginning !== false,
    batchSize: Math.floor(numberOption(options.batchSize, 1, 1)),
    retryDelayMs: Math.max(MIN_RETRY_DELAY_MS, numberOption(options.errorRetryDelay, 5000)),
    partitionsConsumedConcurrently: Math.floor(numberOption(options.partitionsConsumedConcurrently, 0)),
    autoCommitIntervalMs: numberOption(options.autoCommitInterval, 0),
    sessionTimeoutMs,
    // the session ends after three missed heartbeats
    heartbeatIntervalMs: Math.min(
      numberOption(options.heartbeatInterval, 10_000, 1),
      Math.max(1, Math.floor(sessionTimeoutMs / 3)),
    ),
    rebalanceTimeoutMs: numberOption(options.rebalanceTimeout, 600_000, 1),
    fetchMaxBytes: numberOption(options.fetchMaxBytes, 1_048_576, 1),
    fetchMinBytes: numberOption(options.fetchMinBytes, 1, 1),
    maxInFlightRequests: numberOption(options.maxInFlightRequests, 1, 1),
    parser: {
      jsonParseMessage: options.jsonParseMessage === true,
      keepBinaryData: options.keepBinaryData === true,
      onlyMessage: options.onlyMessage === true,
      returnHeaders: options.returnHeaders === true,
    },
  };
}

export function consumerConfig(
  settings: TriggerSettings,
  restartOnFailure: (error: Error) => Promise<boolean>,
): ConsumerConfig {
  return {
    groupId: settings.groupId,
    sessionTimeout: settings.sessionTimeoutMs,
    heartbeatInterval: settings.heartbeatIntervalMs,
    rebalanceTimeout: settings.rebalanceTimeoutMs,
    maxBytes: settings.fetchMaxBytes,
    maxBytesPerPartition: settings.fetchMaxBytes,
    minBytes: settings.fetchMinBytes,
    maxInFlightRequests: settings.maxInFlightRequests,
    allowAutoTopicCreation: false,
    retry: { retries: CONSUMER_RETRIES, restartOnFailure },
  };
}

/** may the offset of a chunk move, given how its run ended */
export function mayAdvance(
  mode: ResolveOffsetMode,
  allowedStatuses: string[],
  run: TriggerRunResult,
): boolean {
  if (mode === 'onSuccess') return run.status === 'success';
  if (mode === 'onStatus') return allowedStatuses.includes(run.status);
  return true;
}

function isGroupDenied(error: unknown): boolean {
  for (let current = error as { type?: string; originalError?: unknown } | undefined; current; ) {
    if (current.type === 'GROUP_AUTHORIZATION_FAILED') return true;
    current = current.originalError as typeof current;
  }
  return false;
}

export interface ConsumeDeps {
  /** builds the consumer; `restartOnFailure` is false until the start has succeeded */
  createConsumer(restartOnFailure: (error: Error) => Promise<boolean>): Consumer;
  parse(message: KafkaMessage, topic: string): Promise<Item>;
  emit: TriggerContext['emit'];
  emitError: TriggerContext['emitError'];
  logger: Pick<Logger, 'debug' | 'warn'>;
}

export function createTopicConsumer(deps: ConsumeDeps, options: ConsumeOptions) {
  const { logger } = deps;
  let started = false;
  let closing = false;
  let settleStart: () => void = () => undefined;
  let failStart: (error: Error) => void = () => undefined;
  let starting: Promise<unknown> = Promise.resolve();
  let closed: Promise<void> | undefined;
  const waiting = new Set<() => void>();

  /** `work`, or undefined as soon as the close is asked for; leaves nothing behind when `work` ends first */
  function orClosed<T>(work: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      if (closing) {
        work.catch(() => undefined);
        resolve(undefined);
        return;
      }
      const wake = () => resolve(undefined);
      waiting.add(wake);
      work.then(resolve, reject).finally(() => waiting.delete(wake));
    });
  }

  const consumer = deps.createConsumer(async () => started && !closing);

  consumer.on(consumer.events.GROUP_JOIN, () => settleStart());
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (closing) return;
    if (!started) failStart(payload.error);
    else if (payload.restart) logger.warn('Kafka consumer is restarting after an error');
    else deps.emitError(payload.error);
  });

  async function delay(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await orClosed(
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    );
    clearTimeout(timer);
  }

  /** give a chunk to a run; true when its offset may move */
  async function deliver(messages: KafkaMessage[], topic: string): Promise<boolean> {
    let items: Item[];
    try {
      items = await Promise.all(messages.map((message) => deps.parse(message, topic)));
    } catch (error) {
      logger.warn(`Kafka messages left unread: ${(error as Error).message}`);
      return false;
    }
    if (closing) return false;

    if (options.manual || options.resolveOffset === 'immediately') {
      deps.emit([items]);
      return true;
    }

    const run = new Promise<TriggerRunResult>((resolve, reject) => {
      deps.emit([items], { resolve, reject });
    });
    // the close releases a run still in flight: its offset stays, and Kafka delivers the chunk again
    const result = await orClosed(run).catch(() => {
      logger.warn('The run could not start, offsets not resolved');
      return false as const;
    });
    if (!result) return false;
    if (mayAdvance(options.resolveOffset, options.allowedStatuses, result)) return true;
    logger.warn(`Execution status is not allowed for resolving offsets, current status: ${result.status}`);
    return false;
  }

  async function eachBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, uncommittedOffsets } = payload;
    const { topic, partition, messages } = batch;
    for (let index = 0; index < messages.length; index += options.batchSize) {
      if (closing || !payload.isRunning() || payload.isStale()) return;
      const chunk = messages.slice(index, index + options.batchSize);

      // kafkajs sends heartbeats only when asked, and a run can outlast the session
      const pump = setInterval(
        () => {
          heartbeat().catch((error: Error) => logger.debug(`Kafka heartbeat failed: ${error.message}`));
        },
        Math.max(50, Math.floor(options.heartbeatIntervalMs / 2)),
      );
      let advance: boolean;
      try {
        advance = await deliver(chunk, topic);
        if (!advance) await delay(options.retryDelayMs);
      } finally {
        clearInterval(pump);
      }
      if (closing && !advance) return;
      if (!advance) {
        consumer.seek({ topic, partition, offset: chunk[0]!.offset });
        return;
      }

      resolveOffset(chunk[chunk.length - 1]!.offset);
      // with no interval each chunk commits at once, so a crash replays as little as it can
      await (options.autoCommitIntervalMs > 0
        ? commitOffsetsIfNecessary()
        : commitOffsetsIfNecessary(uncommittedOffsets()));
      await heartbeat();
    }
  }

  async function runConsumer(joined: Promise<void>): Promise<void> {
    await consumer.connect();
    if (closing) return;
    await consumer.subscribe({
      topics: [options.topic.startsWith('^') ? new RegExp(options.topic) : options.topic],
      fromBeginning: options.fromBeginning,
    });
    if (closing) return;
    await consumer.run({
      autoCommit: true,
      autoCommitInterval: options.autoCommitIntervalMs > 0 ? options.autoCommitIntervalMs : null,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: Math.max(1, options.partitionsConsumedConcurrently),
      eachBatch,
    });
    // kafkajs reports a failed start only as a crash event
    await joined;
  }

  return {
    /** resolves once the group is joined; a close during the start ends it without an error */
    async start(): Promise<void> {
      if (closing) return;
      const joined = new Promise<void>((resolve, reject) => {
        settleStart = resolve;
        failStart = reject;
      });
      const running = runConsumer(joined);
      starting = running.catch(() => undefined);
      try {
        await orClosed(running);
        if (!closing) started = true;
      } catch (error) {
        await consumer.disconnect().catch(() => undefined);
        if (options.manual && isGroupDenied(error)) {
          const prefix = testGroupPrefix(options.configuredGroupId);
          throw new WorkflowError('Kafka refused the consumer group used for a test run', {
            description: `A test run uses a throwaway consumer group so it cannot mark messages read for the live workflow, and this cluster has not authorized it. Grant a prefixed group ACL for "${prefix}", or run the workflow published instead of testing it.`,
            cause: error,
          });
        }
        throw error;
      }
    },

    /** bounded: a hung broker cannot block the deactivation */
    close(): Promise<void> {
      closed ??= (async () => {
        closing = true;
        settleStart();
        for (const wake of waiting) wake();
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn('Kafka consumer did not stop in time');
            resolve();
          }, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
        });
        const stopping = starting.then(() => consumer.disconnect());
        await Promise.race([stopping.catch(() => undefined), limit]);
        clearTimeout(timer);
      })();
      return closed;
    },
  };
}
