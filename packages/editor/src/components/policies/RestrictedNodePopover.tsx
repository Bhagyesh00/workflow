/**
 * P6-50 (L5): the lock on a restricted row of the node creator: why the type is blocked and a
 * "Contact admin" action. The row stays greyed and sorted last; picking it adds nothing.
 */
import { Lock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { AvailableType } from '../../api/types';
import { restrictedReason } from '../../lib/policy-violations';
import { Button } from '../ui/Button';

export interface RestrictedNodePopoverProps {
  /** the unavailable row of `useAvailableTypes` */
  entry: AvailableType;
  /** the type's display name */
  displayName: string;
  /** opens `ContactAdminDialog` for this type */
  onContactAdmin(): void;
}

export function RestrictedNodePopover({
  entry,
  displayName,
  onContactAdmin,
}: RestrictedNodePopoverProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
        aria-label={`Why ${displayName} is restricted`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Lock size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${displayName} is restricted`}
          className="absolute top-8 right-0 z-20 flex w-60 flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left shadow-lift"
        >
          <p className="text-sm font-semibold text-ink">{displayName} is restricted</p>
          <p className="text-xs text-ink-2">{restrictedReason(entry)}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOpen(false);
              onContactAdmin();
            }}
          >
            Contact admin
          </Button>
        </div>
      )}
    </span>
  );
}
