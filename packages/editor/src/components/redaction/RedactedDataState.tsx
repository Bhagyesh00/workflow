/**
 * P6-53 (L8): what the output pane and the execution page show for a redacted run, with Reveal when
 * `info.canReveal`.
 */
import { EyeOff } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { executionsApi } from '../../api/endpoints';
import type { ExecutionDetail, RedactionInfo } from '../../api/types';
import { useRunStore } from '../../stores/run-store';
import { Button } from '../ui/Button';
import { RevealDataDialog } from './RevealDataDialog';

export interface RedactedDataStateProps {
  info: RedactionInfo;
  executionId: string;
  /** the revealed run (`executionsApi.get(id, { redactExecutionData: false })`) */
  onRevealed?(execution: ExecutionDetail): void;
}

/** why the data is hidden, in the words of the reasons the server gives */
export function redactionReason(info: RedactionInfo): string {
  if (info.reason === 'sub_workflow_redaction_policy') {
    return 'A workflow this run called redacts its data, so the data of this run is hidden too.';
  }
  if (info.reason === 'credential_access') {
    return "This run used a credential you can't use, so its data is hidden.";
  }
  if (info.reason === 'workflow_redaction_policy') {
    return 'This workflow redacts the data of its executions.';
  }
  return 'The data of this execution is redacted.';
}

export function RedactedDataState({ info, executionId, onRevealed }: RedactedDataStateProps): ReactNode {
  const [asking, setAsking] = useState(false);
  return (
    <div role="status" className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <EyeOff size={22} className="text-ink-3" aria-hidden="true" />
      <p className="font-semibold text-ink">The data of this execution is redacted</p>
      <p className="max-w-md text-sm text-ink-2">{redactionReason(info)}</p>
      {info.canReveal ? (
        <>
          <Button size="sm" onClick={() => setAsking(true)}>
            Reveal data
          </Button>
          <RevealDataDialog
            open={asking}
            onClose={() => setAsking(false)}
            executionId={executionId}
            onRevealed={(execution) => onRevealed?.(execution)}
          />
        </>
      ) : (
        <p className="max-w-md text-xs text-ink-3">
          {info.reason === 'credential_access'
            ? "It can't be revealed to you."
            : 'You need permission to reveal execution data. Ask a project admin or an owner.'}
        </p>
      )}
    </div>
  );
}

/**
 * The redaction of the run the details view shows, read for a node that ran but shows no items (the only case
 * a redacted output hides in): the execution is read once and its `redactionInfo` answered when it is
 * redacted. `reveal` puts the revealed run's run data in the run store. No query cache: the pane renders
 * wherever the details view does.
 */
export function useRunRedaction(enabled: boolean) {
  const executionId = useRunStore((s) => s.executionId);
  const [read, setRead] = useState<{ id: string; info: RedactionInfo | null } | null>(null);
  useEffect(() => {
    if (!enabled || !executionId || read?.id === executionId) return;
    let live = true;
    executionsApi
      .get(executionId)
      .then((execution) => {
        if (live) {
          setRead({
            id: executionId,
            info: execution.redactionInfo?.isRedacted ? execution.redactionInfo : null,
          });
        }
      })
      .catch(() => {
        if (live) setRead({ id: executionId, info: null });
      });
    return () => {
      live = false;
    };
  }, [enabled, executionId, read?.id]);
  const info = read && read.id === executionId ? read.info : null;
  const reveal = (execution: ExecutionDetail) => {
    setRead({ id: execution.id, info: null });
    useRunStore.setState({ runData: execution.state?.resultData?.runData ?? {} });
  };
  return { info, executionId, reveal };
}
