/**
 * The Assistant (P5-67, lane L1): threads of one user in one tenant, chat turns, cancel, resume after a
 * card, the event stream and the leader sweeps. Every method that takes `auth` names its tenant and
 * user; another user's or tenant's thread is 404. C0 stub with the final signatures: the constructor,
 * `sweep`, `pruneThreads` and `close` do not throw (`createContext`, the leader timers and `close()` run
 * them in every server test); the per-request methods throw `not implemented (L1)`.
 */
import type {
  AssistantEvent,
  AssistantMessagesPage,
  AssistantSendMessage,
  AssistantStatusDTO,
  AssistantThreadDTO,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { AiRuntime } from '../ai-builder/runtime';
import type { Actor } from '../workflows';
import type { AssistantToolDefinition } from './types';

export interface AssistantServiceOptions {
  /** `createContext`'s `aiRuntime` (tests); else `loadAiRuntime` loads the installed AI package */
  aiRuntime?: AiRuntime;
  /** `createContext`'s `assistantTools`: the test seam, offered after the built-in tools */
  extraTools?: AssistantToolDefinition[];
}

export interface AssistantThreadListQuery {
  limit: number;
  cursor?: string;
}

export class AssistantService {
  readonly extraTools: AssistantToolDefinition[];

  constructor(
    readonly deps: ServiceDeps,
    readonly options: AssistantServiceOptions = {},
  ) {
    this.extraTools = options.extraTools ?? [];
  }

  async createThread(_auth: AuthContext, _body?: { title?: string }): Promise<AssistantThreadDTO> {
    throw new Error('not implemented (L1)');
  }

  /** the caller's threads, newest first (keyset on updated_at, id) */
  async listThreads(
    _auth: AuthContext,
    _query: AssistantThreadListQuery,
  ): Promise<{ data: AssistantThreadDTO[]; nextCursor: string | null }> {
    throw new Error('not implemented (L1)');
  }

  async getThread(_auth: AuthContext, _threadId: string): Promise<AssistantThreadDTO> {
    throw new Error('not implemented (L1)');
  }

  async renameThread(_auth: AuthContext, _threadId: string, _title: string): Promise<AssistantThreadDTO> {
    throw new Error('not implemented (L1)');
  }

  /** cancels the run first and denies its cards, then deletes the thread and its binary data */
  async deleteThread(_auth: AuthContext, _threadId: string): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** every stored message (summarized ones too), attachments as refs only, and `nextEventId` */
  async messages(_auth: AuthContext, _threadId: string): Promise<AssistantMessagesPage> {
    throw new Error('not implemented (L1)');
  }

  async status(_auth: AuthContext, _threadId: string): Promise<AssistantStatusDTO> {
    throw new Error('not implemented (L1)');
  }

  /**
   * Starts a turn and answers `{ runId }` at once. `actor` carries the request's IP (default: the
   * caller with no IP).
   */
  async chat(
    _auth: AuthContext,
    _threadId: string,
    _body: AssistantSendMessage,
    _actor?: Actor,
  ): Promise<{ runId: string }> {
    throw new Error('not implemented (L1)');
  }

  /** idempotent; crosses mains on the bus; pending cards denied */
  async cancel(_auth: AuthContext, _threadId: string): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** a new turn from the stored history with one short status turn (after a card) */
  async resumeThread(_tenantId: string, _userId: string, _threadId: string, _actor: Actor): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** runs the approved cards of the thread in call order under one run lock, then resumes the turn */
  async settleConfirmations(
    _tenantId: string,
    _userId: string,
    _threadId: string,
    _actor: Actor,
  ): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** the one door for events sent outside a turn (L3's confirm, L7's Accept); the stored id */
  async publish(_tenantId: string, _threadId: string, _event: AssistantEvent): Promise<number> {
    throw new Error('not implemented (L1)');
  }

  /** replays stored events after `afterId`, then follows live ones; resolves with the unsubscribe function */
  async subscribe(
    _auth: AuthContext,
    _threadId: string,
    _afterId: number,
    _onEvent: (event: AssistantEvent) => void,
  ): Promise<() => void> {
    throw new Error('not implemented (L1)');
  }

  /** leader, every 30 s: stale runs and expired cards (C0: does nothing) */
  async sweep(_now: Date): Promise<void> {}

  /** leader, every `INSTANCE_AI_PRUNE_INTERVAL`: the thread TTL (C0: does nothing) */
  async pruneThreads(_now: Date): Promise<void> {}

  /** aborts this process's turns and drops subscriptions (C0: nothing to close) */
  async close(): Promise<void> {}
}
