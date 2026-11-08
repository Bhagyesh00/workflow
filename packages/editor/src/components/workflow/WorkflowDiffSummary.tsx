/**
 * Plain-language summary of `diffWorkflows` (layout changes are ignored): what restoring a
 * version would change compared to the canvas as it is now.
 */
import type { WorkflowDiff } from '@workflow/workflow';
import { ArrowRightLeft, Minus, Pencil, Plus, Settings2, Spline } from 'lucide-react';
import type { ReactNode } from 'react';

function Row({
  icon,
  children,
  tone,
}: {
  icon: ReactNode;
  children: ReactNode;
  tone: 'add' | 'remove' | 'change';
}) {
  const colors = { add: 'text-ok', remove: 'text-err', change: 'text-warn' };
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-0.5 ${colors[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1 text-ink">{children}</span>
    </li>
  );
}

function paths(changes: Array<{ path: string }>): string {
  const shown = changes.slice(0, 3).map((c) => c.path.replace(/^parameters\./, ''));
  return shown.join(', ') + (changes.length > 3 ? ` and ${changes.length - 3} more` : '');
}

export function WorkflowDiffSummary({
  diff,
  label = 'Changes if restored',
}: {
  diff: WorkflowDiff;
  /** the list's accessible name; the builder's draft review passes its own */
  label?: string;
}) {
  if (diff.isEmpty) {
    return (
      <p className="text-sm text-ink-2">Same logic as the canvas. Only positions differ, if anything.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" aria-label={label}>
      {diff.nodes.added.map((n) => (
        <Row key={`a-${n.id}`} icon={<Plus size={14} />} tone="add">
          Adds <strong>{n.name}</strong>
        </Row>
      ))}
      {diff.nodes.removed.map((n) => (
        <Row key={`r-${n.id}`} icon={<Minus size={14} />} tone="remove">
          Removes <strong>{n.name}</strong>
        </Row>
      ))}
      {diff.nodes.renamed.map((n) => (
        <Row key={`n-${n.id}`} icon={<ArrowRightLeft size={14} />} tone="change">
          Renames <strong>{n.from}</strong> to <strong>{n.to}</strong>
        </Row>
      ))}
      {diff.nodes.changed.map((n) => (
        <Row key={`c-${n.id}`} icon={<Pencil size={14} />} tone="change">
          Changes <strong>{n.name}</strong>:{' '}
          <span className="font-mono text-xs text-ink-2">{paths(n.changes)}</span>
        </Row>
      ))}
      {diff.connections.added.length + diff.connections.removed.length > 0 && (
        <Row icon={<Spline size={14} />} tone="change">
          Rewires {diff.connections.added.length + diff.connections.removed.length} connection
          {diff.connections.added.length + diff.connections.removed.length === 1 ? '' : 's'}
          {diff.connections.added.slice(0, 2).map((c) => (
            <span key={`${c.from}-${c.to}-${c.output}-${c.input}`} className="block text-xs text-ink-2">
              {c.from} to {c.to}
            </span>
          ))}
        </Row>
      )}
      {diff.settings.length > 0 && (
        <Row icon={<Settings2 size={14} />} tone="change">
          Changes settings: <span className="font-mono text-xs text-ink-2">{paths(diff.settings)}</span>
        </Row>
      )}
      {diff.other.some((c) => c.path === 'name') && (
        <Row icon={<Pencil size={14} />} tone="change">
          Renames the workflow
        </Row>
      )}
    </ul>
  );
}
