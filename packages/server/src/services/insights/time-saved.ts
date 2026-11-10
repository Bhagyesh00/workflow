/**
 * P6-05, P6-56: minutes saved by one finished run (n8n's computeTimeSavedMinutes, behaviour compared). FULL
 * in C0, so the collector (L11) and the Track Time Saved node (L12) share no edge.
 * - not a success, or a mode that saves no time (manual, chat, integrated, internal, error): undefined;
 * - `timeSavedMode` other than `dynamic` (also unset): the fixed `timeSavedPerExecution`, 0 when unset
 *   (not multiplied by items);
 * - `dynamic`: the sum of `metadata.timeSaved.minutes` the nodes put in their tasks, 0 when none.
 */
import type { ExecutionMode, ExecutionStatus, RunData, WorkflowSettings } from '@workflow/workflow';

/** the production modes that save time (error workflows are operational work, so `error` is not one) */
export const TIME_SAVED_MODES: ReadonlySet<ExecutionMode> = new Set([
  'cli',
  'retry',
  'trigger',
  'webhook',
  'evaluation',
]);

const minutesOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function computeTimeSavedMinutes(
  settings: WorkflowSettings | null | undefined,
  runData: RunData | null | undefined,
  status: ExecutionStatus,
  mode: ExecutionMode,
): number | undefined {
  if (status !== 'success' || !TIME_SAVED_MODES.has(mode)) return undefined;
  if (settings?.timeSavedMode !== 'dynamic') return minutesOf(settings?.timeSavedPerExecution);
  let total = 0;
  for (const tasks of Object.values(runData ?? {})) {
    for (const task of tasks ?? []) {
      const saved = task?.metadata?.timeSaved as { minutes?: unknown } | undefined;
      total += minutesOf(saved?.minutes);
    }
  }
  return total;
}
