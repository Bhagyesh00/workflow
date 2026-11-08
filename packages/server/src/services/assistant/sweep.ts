/**
 * The Assistant's leader sweeps (P5-67, lane L1; the two timers are C0e's in context.ts). `sweepRuns`
 * (every 30 s): a run whose heartbeat is older than `ASSISTANT_STALE_RUN_MS` (its main crashed) gets a
 * `tool-error` result for each call it left open, `run-finish` `error` and its lock released, then
 * `approvals.sweepExpired(now)`. `pruneThreads` (`INSTANCE_AI_PRUNE_INTERVAL`): threads past
 * `INSTANCE_AI_THREAD_TTL_DAYS` deleted with their binary data, skipping a thread with an active run or
 * an open card. Neither throws: a failure is logged without any message text.
 */
import type { ServerContext } from '../../context';

/** what a run that lost its main (or its lock) leaves on its open calls and its finish */
export const ASSISTANT_RUN_LOST = 'The run stopped unexpectedly before it finished';

/** a running turn writes its heartbeat this often */
export const ASSISTANT_HEARTBEAT_MS = 30_000;
/** a run whose heartbeat is older than this is stale (crashed main) */
export const ASSISTANT_STALE_RUN_MS = 120_000;

const DAY_MS = 86_400_000;

/** stale runs and expired cards; never throws */
export async function sweepRuns(ctx: ServerContext, now: Date): Promise<void> {
  const repo = ctx.repos.assistantThreads;
  try {
    const stale = await repo.listStaleRuns(new Date(now.getTime() - ASSISTANT_STALE_RUN_MS));
    for (const thread of stale) {
      const runId = thread.activeRunId;
      if (!runId) continue;
      try {
        for (const call of await repo.openToolCalls(thread.tenantId, thread.id)) {
          await repo.appendMessage(thread.tenantId, thread.id, {
            runId: call.runId,
            role: 'tool',
            content: `Error: ${ASSISTANT_RUN_LOST}`,
            toolCallId: call.id,
            name: call.name,
          });
          await ctx.assistant.publish(thread.tenantId, thread.id, {
            type: 'tool-error',
            runId,
            payload: { toolCallId: call.id, toolName: call.name, error: ASSISTANT_RUN_LOST },
          });
        }
        await ctx.assistant.publish(thread.tenantId, thread.id, {
          type: 'run-finish',
          runId,
          payload: { status: 'error', reason: ASSISTANT_RUN_LOST },
        });
        await repo.releaseRun(thread.tenantId, thread.id, runId);
      } catch (error) {
        ctx.logger.warn(
          {
            tenantId: thread.tenantId,
            threadId: thread.id,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Assistant stale run sweep failed',
        );
      }
    }
  } catch (error) {
    ctx.logger.warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      'Assistant stale run sweep failed',
    );
  }
  try {
    await ctx.assistantApprovals.sweepExpired(now);
  } catch (error) {
    ctx.logger.warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      'Assistant card sweep failed',
    );
  }
}

/** the thread TTL; never throws */
export async function pruneThreads(ctx: ServerContext, now: Date): Promise<void> {
  const days = ctx.config.assistant.threadTtlDays;
  if (!days || days <= 0) return;
  const before = new Date(now.getTime() - days * DAY_MS);
  const repo = ctx.repos.assistantThreads;
  try {
    for (const thread of await repo.listExpiredThreads(before)) {
      // the delete itself checks again: a run or a card that came after the listing keeps the thread
      if (await repo.deleteIfIdle(thread.tenantId, thread.id, before)) {
        await ctx.executions.removeBinaryData(thread.tenantId, thread.id);
      }
    }
  } catch (error) {
    ctx.logger.warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      'Assistant thread pruning failed',
    );
  }
}
