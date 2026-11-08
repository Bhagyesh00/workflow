/**
 * Sessions of the MCP Server Trigger (P5-03). A session binds tenant, workflow, node and the subject's hash
 * (who authenticated); a read with another workflow's or subject's id answers 404 (the service compares them).
 * Queue mode keeps them in Redis with a TTL, so any main can answer; otherwise in memory with a tenant cap.
 * Idle TTL and sweep interval from `config.mcp`. A session with a call in flight is never evicted: the
 * service touches it while the call runs, and the main holding an SSE stream touches it on each keep-alive.
 *
 * The factory, `startSweep`, `sweep` and `close` never throw (`createContext` and `close()` run them in
 * every server test).
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Config } from '../config';
import type { PinoLogger } from '../logger';

export interface McpSessionRecord {
  tenantId: string;
  workflowId: string;
  nodeName: string;
  /** SHA-256 of the authenticated subject (token, header or user), '' with no auth */
  subjectHash: string;
  protocolVersion: string;
  /** Streamable HTTP, or the legacy SSE stream held by one main */
  transport: 'http' | 'sse';
  /** epoch ms of the last request */
  lastSeen: number;
}

export interface McpSessionStore {
  /** stores a new session and returns its id (`Mcp-Session-Id`, or the SSE `sessionId`) */
  create(record: Omit<McpSessionRecord, 'lastSeen'>): Promise<string>;
  /** the session, or undefined when unknown or idle past the TTL */
  get(id: string): Promise<McpSessionRecord | undefined>;
  /** marks the session used now; false when it is gone */
  touch(id: string): Promise<boolean>;
  /** ends the session; true when it existed */
  delete(id: string): Promise<boolean>;
  /** the legacy SSE streams this tenant holds (the per-tenant cap) */
  countStreams(tenantId: string): Promise<number>;
  /** starts the idle sweep (`config.mcp.sessionSweepMs`, unref'd); called once by `startMain` */
  startSweep(): void;
  /** removes sessions idle past `config.mcp.sessionIdleTtlMs`; returns how many went */
  sweep(now?: number): Promise<number>;
  /** stops the sweep and drops what this process holds */
  close(): Promise<void>;
}

export interface McpSessionStoreDeps {
  config: Config;
  logger: PinoLogger;
  /** the context's Redis; the store uses it in queue mode */
  redis?: Redis;
}

/** sessions one workspace may hold in a main's memory; the least recently used one goes first */
export const MCP_TENANT_SESSION_CAP = 1000;

/** session ids are UUIDs; anything else is never looked up */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMcpSessionId = (id: string): boolean => SESSION_ID.test(id);

class MemoryMcpSessionStore implements McpSessionStore {
  private readonly sessions = new Map<string, McpSessionRecord>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: McpSessionStoreDeps) {}

  private get ttl() {
    return this.deps.config.mcp.sessionIdleTtlMs;
  }

  private idle(record: McpSessionRecord, now = Date.now()) {
    return now - record.lastSeen > this.ttl;
  }

  async create(record: Omit<McpSessionRecord, 'lastSeen'>): Promise<string> {
    const own = [...this.sessions].filter(([, r]) => r.tenantId === record.tenantId);
    if (own.length >= MCP_TENANT_SESSION_CAP) {
      // Map order is insertion order and touch re-inserts, so the first is the least recently used
      this.sessions.delete(own[0][0]);
    }
    const id = randomUUID();
    this.sessions.set(id, { ...record, lastSeen: Date.now() });
    return id;
  }

  async get(id: string): Promise<McpSessionRecord | undefined> {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (this.idle(record)) {
      this.sessions.delete(id);
      return undefined;
    }
    return { ...record };
  }

  async touch(id: string): Promise<boolean> {
    const record = this.sessions.get(id);
    if (!record || this.idle(record)) {
      this.sessions.delete(id);
      return false;
    }
    this.sessions.delete(id);
    this.sessions.set(id, { ...record, lastSeen: Date.now() });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async countStreams(tenantId: string): Promise<number> {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.tenantId === tenantId && record.transport === 'sse' && !this.idle(record)) count++;
    }
    return count;
  }

  startSweep(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch(() => {});
    }, this.deps.config.mcp.sessionSweepMs);
    this.timer.unref();
  }

  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.sessions) {
      if (!this.idle(record, now)) continue;
      this.sessions.delete(id);
      removed++;
    }
    return removed;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sessions.clear();
  }
}

/** queue mode: one key per session with the idle TTL as its expiry, so every main reads the same sessions */
class RedisMcpSessionStore implements McpSessionStore {
  constructor(
    private readonly deps: McpSessionStoreDeps,
    private readonly redis: Redis,
  ) {}

  private get ttl() {
    return this.deps.config.mcp.sessionIdleTtlMs;
  }

  private key(id: string) {
    return `${this.deps.config.queue.prefix}:mcp-session:${id}`;
  }

  /** a sorted set of a workspace's SSE sessions scored by when they expire */
  private streamsKey(tenantId: string) {
    return `${this.deps.config.queue.prefix}:mcp-streams:${tenantId}`;
  }

  private async read(id: string): Promise<McpSessionRecord | undefined> {
    if (!isMcpSessionId(id)) return undefined;
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpSessionRecord;
    } catch {
      return undefined;
    }
  }

  private async write(id: string, record: McpSessionRecord): Promise<void> {
    await this.redis.set(this.key(id), JSON.stringify(record), 'PX', this.ttl);
    if (record.transport === 'sse') {
      const streams = this.streamsKey(record.tenantId);
      await this.redis.zadd(streams, record.lastSeen + this.ttl, id);
      await this.redis.pexpire(streams, this.ttl * 2);
    }
  }

  async create(record: Omit<McpSessionRecord, 'lastSeen'>): Promise<string> {
    const id = randomUUID();
    await this.write(id, { ...record, lastSeen: Date.now() });
    return id;
  }

  async get(id: string): Promise<McpSessionRecord | undefined> {
    return this.read(id);
  }

  async touch(id: string): Promise<boolean> {
    const record = await this.read(id);
    if (!record) return false;
    await this.write(id, { ...record, lastSeen: Date.now() });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const record = await this.read(id);
    if (!record) return false;
    const removed = await this.redis.del(this.key(id));
    if (record.transport === 'sse') await this.redis.zrem(this.streamsKey(record.tenantId), id);
    return removed > 0;
  }

  async countStreams(tenantId: string): Promise<number> {
    const streams = this.streamsKey(tenantId);
    await this.redis.zremrangebyscore(streams, '-inf', Date.now());
    return this.redis.zcard(streams);
  }

  // Redis expires idle sessions itself
  startSweep(): void {}

  async sweep(): Promise<number> {
    return 0;
  }

  // the Redis connection is the context's; it closes it
  async close(): Promise<void> {}
}

/** the store of this process: Redis in queue mode, else memory */
export function createMcpSessionStore(deps: McpSessionStoreDeps): McpSessionStore {
  if (deps.config.executionsMode === 'queue' && deps.redis) return new RedisMcpSessionStore(deps, deps.redis);
  return new MemoryMcpSessionStore(deps);
}
