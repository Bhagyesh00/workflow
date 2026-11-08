/**
 * The AI workflow builder service (P5-09, L1). One `build` call is one turn:
 * 1. load the session and the draft, build the `BuilderTurnState` (turn-local AbortController joined
 *    to `signal` with `AbortSignal.any`; `stopTurn` aborts it with `BUILDER_TURN_STOP`);
 * 2. the seams, in this order: `applyPlanResume` (plan.ts), `applyWebFetchResume` (web-fetch.ts),
 *    `maybeCompact` (compaction.ts);
 * 3. only then read `state.mode`: build mode offers `createBuilderTools` plus `webFetchTools`, plan mode
 *    only `planTools(state, readBuilderTools(draft, deps))`; `promptNotes` go into the turn's input;
 * 4. `runAgent` from `loadAiRuntime`, at most 50 iterations, streamed text as `message` chunks;
 * 5. `saveTurn`. A `BUILDER_TURN_STOP` abort is a clean end (turn saved, no `error` chunk).
 */
import type { BuilderChunk, BuildRequest } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import { type AiRuntime, loadAiRuntime } from './runtime';

export class AiBuilderService {
  private runtimePromise?: Promise<AiRuntime | undefined>;

  /** `runtimeOverride` is `createContext`'s `aiRuntime` option (tests); else the installed AI package */
  constructor(
    readonly deps: ServiceDeps,
    private readonly runtimeOverride?: AiRuntime,
  ) {}

  /** the AI runtime, loaded once; undefined when the AI package is not installed */
  runtime(): Promise<AiRuntime | undefined> {
    this.runtimePromise ??= loadAiRuntime(this.runtimeOverride);
    return this.runtimePromise;
  }

  /** one builder turn; every chunk goes out through `write` (NDJSON, the route owns the wire) */
  async build(
    _auth: AuthContext,
    _request: BuildRequest,
    _write: (chunk: BuilderChunk) => void,
    _signal: AbortSignal,
  ): Promise<void> {
    throw new Error('not implemented (L1)');
  }

  /** stops running turns on shutdown; C0 has none */
  async close(): Promise<void> {}
}
