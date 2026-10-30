/** Workflow Doctor panel: live static checks of the open workflow, grouped by severity. */
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Stethoscope, X } from 'lucide-react';
import type { DoctorIssue, IssueSeverity } from '../../lib/doctor';
import { cx } from '../ui/cx';
import { EmptyState } from '../ui/misc';

const icons: Record<IssueSeverity, React.ReactNode> = {
  error: <AlertOctagon size={15} className="text-err" aria-label="Error" />,
  warning: <AlertTriangle size={15} className="text-warn" aria-label="Warning" />,
  info: <Info size={15} className="text-brand" aria-label="Note" />,
};

export function DoctorPanel({
  issues,
  onClose,
  onFocusNode,
}: {
  issues: DoctorIssue[];
  onClose: () => void;
  onFocusNode: (name: string) => void;
}) {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return (
    <aside
      className="flex h-full w-[360px] flex-col border-l border-line bg-surface shadow-lift"
      aria-label="Workflow Doctor"
    >
      <div className="flex items-start gap-2 px-4 pt-4 pb-3">
        <Stethoscope size={18} className="mt-0.5 text-brand" />
        <div className="flex-1">
          <h2 className="text-md font-semibold">Workflow Doctor</h2>
          <p className="text-xs text-ink-2">Checks run as you edit, before anything executes.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Workflow Doctor"
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-2 px-4 pb-3 text-xs">
        <span
          className={cx(
            'rounded-full px-2 py-0.5 font-semibold',
            errors ? 'bg-err-soft text-err' : 'bg-surface-3 text-ink-2',
          )}
        >
          {errors} to fix
        </span>
        <span
          className={cx(
            'rounded-full px-2 py-0.5 font-semibold',
            warnings ? 'bg-warn-soft text-warn' : 'bg-surface-3 text-ink-2',
          )}
        >
          {warnings} to review
        </span>
      </div>
      <div className="wf-scroll min-h-0 flex-1 overflow-y-auto border-t border-line">
        {issues.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={20} className="text-ok" />}
            title="No problems found"
            description="Required fields, credentials, wiring and expression references all check out."
          />
        ) : (
          <ul className="divide-y divide-line">
            {issues.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  disabled={!issue.node}
                  onClick={() => issue.node && onFocusNode(issue.node)}
                  className="flex w-full items-start gap-2.5 px-4 py-3 text-left enabled:hover:bg-surface-2"
                >
                  <span className="mt-0.5">{icons[issue.severity]}</span>
                  <span className="min-w-0 flex-1">
                    {issue.node && (
                      <span className="block text-xs font-semibold text-ink-2">{issue.node}</span>
                    )}
                    <span className="block text-sm text-ink">{issue.message}</span>
                    {issue.hint && <span className="mt-0.5 block text-xs text-ink-3">{issue.hint}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
