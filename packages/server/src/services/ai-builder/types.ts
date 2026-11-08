/**
 * Shared state of one AI builder turn (P5-09, C0 FULL). `builder.ts` (L1) builds a `BuilderTurnState`
 * per request and hands it to the seams in this order before any model call: `applyPlanResume` (L3),
 * `applyWebFetchResume` (L4), `maybeCompact` (L6). Only then does it read `mode` for the tool set
 * and the prompt, and put `promptNotes` into the turn's input.
 */
import type { BuilderChunk, BuilderMessage, BuilderMode } from '@workflow/workflow';
import type { BuilderDraft } from './draft';

/**
 * The abort reason `stopTurn` uses. `builder.ts` treats an abort with this reason (also from a seam,
 * before any model call) as a clean end of the turn: the turn is saved and no `error` chunk is sent.
 */
export const BUILDER_TURN_STOP = 'ai-builder:turn-stop' as const;

/** true when `value` (an AbortSignal or an abort reason) is the clean turn stop */
export function isBuilderTurnStop(value: unknown): boolean {
  if (value === BUILDER_TURN_STOP) return true;
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
    return value.aborted && value.reason === BUILDER_TURN_STOP;
  }
  return false;
}

/**
 * Rate limit of every `/rest/ai/*` route: 100 per IP, as n8n's `ipRateLimit` (window 5 minutes,
 * n8n's default window).
 */
export const AI_ROUTE_RATE_LIMIT = { max: 100, timeWindow: 300_000 } as const;

/** one builder conversation: this workflow and this user in this tenant */
export interface BuilderSessionKey {
  tenantId: string;
  workflowId: string;
  userId: string;
}

/**
 * The session a turn works on (the `workflow_builder_sessions` row, or an empty one before the first
 * save). Seams may change it during the turn; `saveTurn` (L1) writes it back.
 */
export interface BuilderSession extends BuilderSessionKey {
  /** the stored conversation, oldest first */
  messages: BuilderMessage[];
  /** summary of compacted messages (L6); wrapped as untrusted when sent to a model */
  previousSummary: string | null;
  activeVersionCardId: string | null;
  resumeAfterRestoreMessageId: string | null;
  /** exact host names the user approved for `web_fetch` (L4) */
  allowedWebDomains: string[];
}

export interface BuilderTurnState {
  /** writable: a resume can move plan to build (L3 `approve`) */
  mode: BuilderMode;
  session: BuilderSession;
  draft: BuilderDraft;
  emit: (chunk: BuilderChunk) => void;
  /** the turn's signal: the request's signal joined with the turn-local stop */
  signal: AbortSignal;
  /** text the seams add (always through `wrapUntrusted` when it holds outside data); L1 puts it in the turn's input */
  promptNotes: string[];
  /** ends the turn cleanly: aborts the turn-local controller with reason `BUILDER_TURN_STOP` */
  stopTurn(): void;
}
