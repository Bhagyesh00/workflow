/**
 * Cross-process messaging. Regular mode uses an in-memory bus; queue mode uses Redis pub/sub so
 * that workers can reach the main that holds an editor's SSE stream or a waiting webhook request.
 *
 * Channels:
 * - `push:<tenantId>`  editor push events of one tenant
 * - `exec-events`      webhook responses and completion of executions someone waits for
 * - `control`          cancellation and trigger (re)activation requests
 * - `log-destinations:reload`  `{ tenantId }`: a workspace's log streaming destinations changed (P6-06, L3)
 * - `otel:reload`      `{ tenantId }`: a workspace's OpenTelemetry settings changed (P6-67, L11)
 */
import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';

export type BusHandler = (message: any) => void;

export interface MessageBus {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: BusHandler): Promise<() => void>;
  close(): Promise<void>;
}

export class MemoryBus implements MessageBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  async publish(channel: string, message: unknown): Promise<void> {
    // decouple from the publisher like a real broker would, and copy the payload
    const copy = JSON.parse(JSON.stringify(message ?? null));
    queueMicrotask(() => this.emitter.emit(channel, copy));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

export class RedisBus implements MessageBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<BusHandler>>();

  constructor(
    url: string,
    private readonly prefix: string,
  ) {
    this.pub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    this.sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
    this.sub.on('message', (channel: string, raw: string) => {
      const name = channel.slice(this.prefix.length + 1);
      const set = this.handlers.get(name);
      if (!set?.size) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      for (const handler of [...set]) {
        try {
          handler(message);
        } catch {
          /* a failing listener must not break the others */
        }
      }
    });
  }

  private key(channel: string) {
    return `${this.prefix}:${channel}`;
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.pub.publish(this.key(channel), JSON.stringify(message ?? null));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(this.key(channel));
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (!current.size) {
        this.handlers.delete(channel);
        void this.sub.unsubscribe(this.key(channel)).catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export interface PushEvent {
  type: string;
  data: unknown;
  /**
   * P6 S1: the workflow the event is about, on the envelope (not in `data`), so each stream drops it for a
   * user who cannot read that workflow (P6-25, routes/push.ts). Absent = the event names no workflow: the
   * stream sends it to owner and admin only, except the workspace events (`workflowReviewChanged`).
   */
  workflowId?: string;
  /** P6-53: the user `data` is for (a manual run's node data); every other stream gets `othersData` instead */
  userId?: string;
  /** P6-53: what every stream but `userId`'s gets in place of `data`; absent = those streams get nothing */
  othersData?: unknown;
}

/**
 * Editor push events (SSE), always scoped to one tenant. One channel per tenant: the per-user filter is on
 * each stream (routes/push.ts), so a share or a move needs no new channel and every main filters alike.
 */
export class PushService {
  constructor(private readonly bus: MessageBus) {}

  send(
    tenantId: string,
    type: string,
    data: unknown,
    options: { workflowId?: string; userId?: string; othersData?: unknown } = {},
  ): void {
    const event: PushEvent = {
      type,
      data,
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.userId && options.othersData !== undefined ? { othersData: options.othersData } : {}),
    };
    void this.bus.publish(`push:${tenantId}`, event).catch(() => {});
  }

  subscribe(tenantId: string, handler: (event: PushEvent) => void): Promise<() => void> {
    return this.bus.subscribe(`push:${tenantId}`, handler);
  }
}
