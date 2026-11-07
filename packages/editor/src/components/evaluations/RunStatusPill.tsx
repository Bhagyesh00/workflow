/** Status pill of a test run or of one case (P5-11). */
import type { TestCaseStatus, TestRunFinalResult, TestRunStatus } from '@workflow/workflow';
import { AlertTriangle, CheckCircle2, CircleDashed, Square, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Spinner } from '../ui/misc';

type Tone = 'neutral' | 'ok' | 'err' | 'run' | 'warn';

const META: Record<TestRunStatus | TestCaseStatus, { label: string; tone: Tone; icon: ReactNode }> = {
  new: { label: 'Pending', tone: 'neutral', icon: <CircleDashed size={12} /> },
  running: { label: 'Running', tone: 'run', icon: <Spinner size={12} /> },
  completed: { label: 'Completed', tone: 'ok', icon: <CheckCircle2 size={12} /> },
  success: { label: 'Succeeded', tone: 'ok', icon: <CheckCircle2 size={12} /> },
  error: { label: 'Failed', tone: 'err', icon: <XCircle size={12} /> },
  cancelled: { label: 'Stopped', tone: 'neutral', icon: <Square size={11} /> },
};

/** the label a status shows; a completed run whose worst case failed reads "Finished with errors" */
export function runStatusLabel(
  status: TestRunStatus | TestCaseStatus,
  finalResult?: TestRunFinalResult | null,
): string {
  if (status === 'completed' && finalResult === 'error') return 'Finished with errors';
  return META[status]?.label ?? status;
}

export function RunStatusPill({
  status,
  finalResult,
}: {
  status: TestRunStatus | TestCaseStatus;
  finalResult?: TestRunFinalResult | null;
}) {
  const meta = META[status] ?? META.new;
  const withErrors = status === 'completed' && finalResult === 'error';
  return (
    <Badge tone={withErrors ? 'warn' : meta.tone}>
      {withErrors ? <AlertTriangle size={12} /> : meta.icon}
      {runStatusLabel(status, finalResult)}
    </Badge>
  );
}

/** true while a run still has cases to run */
export const isActiveRun = (status: TestRunStatus): boolean => status === 'new' || status === 'running';

/** how often a page reads its runs again while one is going */
export const EVALUATION_POLL_MS = 1500;
