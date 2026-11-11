/**
 * P6-81 (L14): the read-only banner while another user or tab holds the write lock, with "Take over" for
 * someone who may edit.
 */
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useCanEditWorkflow } from '../../features/editor/open-resources';
import { useCollaborationStore } from '../../stores/collaboration-store';
import { Button } from '../ui/Button';
import { TakeOverDialog } from './TakeOverDialog';

export interface WriteLockBannerProps {
  workflowId: string;
}

export function WriteLockBanner({ workflowId }: WriteLockBannerProps) {
  const openId = useCollaborationStore((s) => s.workflowId);
  const lockedByOther = useCollaborationStore((s) => s.lockedByOther);
  const writeLock = useCollaborationStore((s) => s.writeLock);
  const canWrite = useCanEditWorkflow();
  const [confirming, setConfirming] = useState(false);
  if (openId !== workflowId || !lockedByOther || !writeLock) return null;
  const holder = writeLock.name.trim() || 'Someone else';
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-warn-soft px-4 py-2 text-sm text-ink"
      data-testid="write-lock-banner"
    >
      <Lock size={15} className="shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{holder} is editing this workflow.</span> It is read-only for you
        until they leave{canWrite ? ' or you take over' : ''}.
      </span>
      {canWrite && (
        <Button size="sm" onClick={() => setConfirming(true)}>
          Take over
        </Button>
      )}
      <TakeOverDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        workflowId={workflowId}
        holderName={writeLock.name}
      />
    </div>
  );
}
