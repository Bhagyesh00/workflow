/** Run, "run in parallel" and Stop test for the Evaluations page (P5-11). */
import { MAX_EVALUATION_CONCURRENCY } from '@workflow/workflow';
import { Play, Square } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../ui/Button';

export const VIEWER_REASON = 'Viewers can read test runs but not start, stop or delete them.';

export interface RunControlsProps {
  /** false for a viewer */
  canWrite: boolean;
  /** the workspace's cases-at-once limit from /settings; the slider goes to the smaller of 10 and this, and is
   * hidden at 1 or while the limit is unknown */
  concurrencyLimit?: number;
  /** why Run cannot start a run (no Evaluation Trigger yet); null when it can */
  blockedReason: string | null;
  /** a run is new or running */
  running: boolean;
  starting: boolean;
  stopping: boolean;
  /** `concurrency` is left out at 1 */
  onStart: (concurrency?: number) => void;
  onStop: () => void;
}

/** the slider's top: 10 at most, the workspace limit when it is lower; 1 (no slider) while the limit is unknown */
export function maxParallel(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(MAX_EVALUATION_CONCURRENCY, Math.floor(limit)));
}

export function RunControls({
  canWrite,
  concurrencyLimit,
  blockedReason,
  running,
  starting,
  stopping,
  onStart,
  onStop,
}: RunControlsProps) {
  const [chosen, setChosen] = useState(1);
  const sliderId = useId();
  const max = maxParallel(concurrencyLimit);
  // a count kept from before the limit was known (or lowered) is cut to it when read
  const parallel = Math.min(Math.max(1, chosen), max);
  const reason = canWrite ? blockedReason : VIEWER_REASON;
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-4 border-0 p-0">
      <legend className="sr-only">Run controls</legend>
      {max > 1 && (
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <label htmlFor={sliderId} className="font-semibold text-ink">
            Run in parallel
          </label>
          <input
            id={sliderId}
            type="range"
            min={1}
            max={max}
            step={1}
            value={parallel}
            disabled={!canWrite || running}
            onChange={(event) => setChosen(Number(event.target.value))}
            className="w-32 accent-brand"
            aria-valuetext={parallel === 1 ? 'One case at a time' : `${parallel} cases at once`}
          />
          <output htmlFor={sliderId} className="w-24 text-xs tabular-nums">
            {parallel === 1 ? 'One at a time' : `${parallel} at once`}
          </output>
        </div>
      )}
      {running ? (
        <Button
          variant="danger"
          icon={<Square size={13} />}
          loading={stopping}
          disabled={!canWrite}
          title={canWrite ? undefined : VIEWER_REASON}
          onClick={onStop}
        >
          Stop test
        </Button>
      ) : (
        <Button
          variant="primary"
          icon={<Play size={13} />}
          loading={starting}
          disabled={!canWrite || blockedReason !== null}
          title={reason ?? undefined}
          onClick={() => onStart(parallel > 1 ? parallel : undefined)}
        >
          Run test
        </Button>
      )}
      {reason && (
        <p className="basis-full text-xs text-ink-3" data-testid="run-controls-reason">
          {reason}
        </p>
      )}
    </fieldset>
  );
}
