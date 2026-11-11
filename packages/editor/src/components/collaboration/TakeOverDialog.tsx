/**
 * P6-81 (L14): confirm before taking the write lock from its holder (`force`).
 */
import { useState } from 'react';
import { takeOverWriteAccess } from '../../stores/collaboration-store';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export interface TakeOverDialogProps {
  open: boolean;
  onClose(): void;
  workflowId: string;
  /** the holder's name */
  holderName?: string;
}

export function TakeOverDialog({ open, onClose, workflowId, holderName }: TakeOverDialogProps) {
  const [busy, setBusy] = useState(false);
  const who = holderName?.trim() || 'Someone else';
  const confirm = async () => {
    setBusy(true);
    const done = await takeOverWriteAccess(workflowId);
    setBusy(false);
    if (done) onClose();
    else toast.error("Couldn't take over editing", 'Try again in a moment.');
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title="Take over editing?"
      description={`${who} is editing this workflow now. If you take over, it turns read-only for them.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void confirm()}>
            Take over
          </Button>
        </>
      }
    />
  );
}
