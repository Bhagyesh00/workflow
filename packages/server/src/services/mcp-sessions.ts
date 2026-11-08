/**
 * Sessions of the MCP Server Trigger (P5-03, filled by L7). A session binds tenant, workflow, node and
 * the subject's hash (who authenticated); a read with another workflow's or subject's id answers 404.
 * Queue mode keeps them in Redis with a TTL, so any main can answer; otherwise in memory with a tenant
 * cap. Idle TTL and sweep interval from `config.mcp`; a session with a call in flight is never evicted.
 *
 * The factory, `startSweep`, `sweep` and `close` never throw (`createContext` and `close()` run them in
 * every server test); the per-request methods throw until L7 fills them.
 */
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

class McpSessionStoreStub implements McpSessionStore {
  constructor(readonly deps: McpSessionStoreDeps) {}

  async create(_record: Omit<McpSessionRecord, 'lastSeen'>): Promise<string> {
    throw new Error('not implemented (L7)');
  }

  async get(_id: string): Promise<McpSessionRecord | undefined> {
    throw new Error('not implemented (L7)');
  }

  async touch(_id: string): Promise<boolean> {
    throw new Error('not implemented (L7)');
  }

  async delete(_id: string): Promise<boolean> {
    throw new Error('not implemented (L7)');
  }

  async countStreams(_tenantId: string): Promise<number> {
    throw new Error('not implemented (L7)');
  }

  startSweep(): void {}

  async sweep(_now?: number): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {}
}

/** the store of this process: Redis in queue mode, else memory */
export function createMcpSessionStore(deps: McpSessionStoreDeps): McpSessionStore {
  return new McpSessionStoreStub(deps);
}
