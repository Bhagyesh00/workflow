/**
 * The Assistant's leader sweeps (P5-67, lane L1; the two timers are C0e's in context.ts). `sweepRuns`
 * (every 30 s): a run whose heartbeat is older than `ASSISTANT_STALE_RUN_MS` gets `run-finish` `error`
 * and its lock released, then `approvals.sweepExpired(now)`. `pruneThreads` (`INSTANCE_AI_PRUNE_INTERVAL`):
 * threads past `INSTANCE_AI_THREAD_TTL_DAYS` deleted with their binary data, skipping a thread with an
 * active run or an open card. In C0 both do nothing (timers call them in every server test).
 */
import type { ServerContext } from '../../context';

/** a running turn writes its heartbeat this often */
export const ASSISTANT_HEARTBEAT_MS = 30_000;
/** a run whose heartbeat is older than this is stale (crashed main) */
export const ASSISTANT_STALE_RUN_MS = 120_000;

/** stale runs and expired cards; never throws (C0: does nothing) */
export async function sweepRuns(_ctx: ServerContext, _now: Date): Promise<void> {}

/** the thread TTL; never throws (C0: does nothing) */
export async function pruneThreads(_ctx: ServerContext, _now: Date): Promise<void> {}
