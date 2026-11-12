/**
 * P6-06 (S5 C0, FULL, C0-final): the in-process event stream. Producers (the lifecycle observers of L1 and L2, the
 * audit listener, the queue and runner events) call `emit`; sinks (log streaming's manager, the metrics event
 * counters) say per tenant and event name whether they want it. The payload is built only when at least one sink
 * accepts, so a workspace with no destination and no metrics toggle pays nothing. Events reach the sinks in emit
 * order (an async payload holds later events back until it is built). `emit` never throws: a throwing `accepts`,
 * payload or `deliver` is logged (never with the payload) and skipped.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import type { PinoLogger } from '../../logger';

export interface StreamEvent {
  /** a random uuid per event */
  id: string;
  /** ISO time of the emit */
  ts: string;
  eventName: string;
  /** n8n's `message`: the event name unless a producer's payload names another */
  message: string;
  payload: DataObject;
  tenantId: string;
}

export interface EventSink {
  /** cheap: called once per emit and sink, before any payload is built */
  accepts(tenantId: string, eventName: string): boolean;
  /** must not block: a sink queues and sends on its own */
  deliver(event: StreamEvent): void;
}

export type EventPayload = DataObject | (() => DataObject | Promise<DataObject>);

const isPromise = (value: unknown): value is Promise<DataObject> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

export class EventStream {
  private readonly sinks: EventSink[] = [];
  /** events whose payload is still being built; later events wait behind them */
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly logger: Pick<PinoLogger, 'warn'>) {}

  /** adds a sink; the returned function removes it */
  addSink(sink: EventSink): () => void {
    this.sinks.push(sink);
    return () => {
      const index = this.sinks.indexOf(sink);
      if (index >= 0) this.sinks.splice(index, 1);
    };
  }

  emit(tenantId: string, eventName: string, payload: EventPayload): void {
    try {
      const accepting = this.sinks.filter((sink) => {
        try {
          return sink.accepts(tenantId, eventName) === true;
        } catch (error) {
          this.logger.warn({ err: error, eventName }, 'An event sink failed to check an event');
          return false;
        }
      });
      if (accepting.length === 0) return;
      const id = randomUUID();
      const ts = new Date().toISOString();
      const build = (): DataObject | Promise<DataObject> =>
        typeof payload === 'function' ? payload() : payload;

      if (this.pending === 0) {
        let built: DataObject | Promise<DataObject>;
        try {
          built = build();
        } catch (error) {
          this.logger.warn({ err: error, eventName }, 'An event payload could not be built');
          return;
        }
        if (!isPromise(built)) {
          this.deliver(accepting, { id, ts, eventName, message: eventName, payload: built ?? {}, tenantId });
          return;
        }
        // handled below through the queue; this keeps an early rejection from being reported as unhandled
        built.catch(() => {});
        this.enqueue(accepting, { id, ts, eventName, tenantId }, () => built);
        return;
      }
      this.enqueue(accepting, { id, ts, eventName, tenantId }, build);
    } catch (error) {
      this.logger.warn({ err: error, eventName }, 'An event could not be emitted');
    }
  }

  /** resolves when every event emitted so far has reached its sinks (tests and close) */
  async flush(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }

  private enqueue(
    accepting: EventSink[],
    head: Pick<StreamEvent, 'id' | 'ts' | 'eventName' | 'tenantId'>,
    build: () => DataObject | Promise<DataObject>,
  ): void {
    this.pending += 1;
    const previous = this.tail;
    this.tail = (async () => {
      await previous;
      try {
        const payload = await build();
        this.deliver(accepting, { ...head, message: head.eventName, payload: payload ?? {} });
      } catch (error) {
        this.logger.warn({ err: error, eventName: head.eventName }, 'An event payload could not be built');
      } finally {
        this.pending -= 1;
      }
    })();
  }

  private deliver(accepting: EventSink[], event: StreamEvent): void {
    for (const sink of accepting) {
      try {
        sink.deliver(event);
      } catch (error) {
        this.logger.warn({ err: error, eventName: event.eventName }, 'An event sink failed to take an event');
      }
    }
  }
}
