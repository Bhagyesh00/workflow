/**
 * P6-86: "Used by N workflow(s)" on a workflow, credential or data table row, from `useDependencyCounts`
 * (one batched POST per page). Nothing shows when nothing uses the resource. Opens `DependencyDetails`.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useDependencyCounts } from '../../api/queries';
import type { DependencyCounts, DependencyResourceKind } from '../../api/types';
import { plural } from '../../lib/format';
import { DependencyDetails, usedByKeys } from './DependencyDetails';

export interface DependencyPillProps {
  kind: DependencyResourceKind;
  id: string;
}

/** how many workflows use the resource */
export function usedByCount(kind: DependencyResourceKind, counts: DependencyCounts | undefined): number {
  if (!counts) return 0;
  return usedByKeys(kind).reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

export function DependencyPill({ kind, id }: DependencyPillProps): ReactNode {
  const counts = useDependencyCounts(kind, id);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const total = usedByCount(kind, counts.data);
  if (!total) return null;
  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded-full bg-surface-3 px-2 py-0.5 text-2xs font-semibold text-ink-2 hover:text-ink"
      >
        Used by {plural(total, 'workflow')}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 max-h-72 min-w-56 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift">
          <DependencyDetails kind={kind} id={id} onClose={() => setOpen(false)} />
        </div>
      )}
    </span>
  );
}
