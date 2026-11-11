/**
 * P6-53 (L8): confirm before revealing a redacted run; the reveal is logged.
 */
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { executionsApi } from '../../api/endpoints';
import type { ExecutionDetail } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export interface RevealDataDialogProps {
  open: boolean;
  onClose(): void;
  executionId: string;
  onRevealed(execution: ExecutionDetail): void;
}

export function RevealDataDialog({
  open,
  onClose,
  executionId,
  onRevealed,
}: RevealDataDialogProps): ReactNode {
  const reveal = useMutation({
    mutationFn: () => executionsApi.get(executionId, { redactExecutionData: false }),
    onSuccess: (execution) => {
      onRevealed(execution);
      onClose();
    },
    onError: (error) => toast.error("Couldn't reveal the data", errorMessage(error)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Reveal execution data"
      description="This action will be logged. The data of this execution stays visible only on this page."
      size="sm"
      dismissible={!reveal.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={reveal.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={reveal.isPending} onClick={() => reveal.mutate()}>
            Reveal data
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-2">
        Anyone with access to the audit log can see who revealed the data and when.
      </p>
    </Dialog>
  );
}
