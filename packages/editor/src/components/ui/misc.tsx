import type { ExecutionStatus } from '@workflow/workflow';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Loader2, Square, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('wf-spinner shrink-0', className)} aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 text-2xs text-ink-2">
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      {icon && (
        <div className="grid size-12 place-items-center rounded-2xl bg-surface-3 text-ink-2">{icon}</div>
      )}
      <div className="max-w-sm">
        <p className="font-display text-md font-semibold text-ink">{title}</p>
        {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-ink-2" role="status">
      <Spinner />
      {label}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'ok' | 'err' | 'run' | 'pin' | 'warn';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-3 text-ink-2',
    brand: 'bg-brand-soft text-brand',
    ok: 'bg-ok-soft text-ok',
    err: 'bg-err-soft text-err',
    run: 'bg-run-soft text-run',
    pin: 'bg-pin-soft text-pin',
    warn: 'bg-warn-soft text-warn',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const statusMeta: Record<
  ExecutionStatus,
  { label: string; tone: 'neutral' | 'ok' | 'err' | 'run' | 'warn'; icon: ReactNode }
> = {
  new: { label: 'Queued', tone: 'neutral', icon: <CircleDashed size={12} /> },
  running: { label: 'Running', tone: 'run', icon: <Spinner size={12} /> },
  success: { label: 'Succeeded', tone: 'ok', icon: <CheckCircle2 size={12} /> },
  error: { label: 'Failed', tone: 'err', icon: <XCircle size={12} /> },
  canceled: { label: 'Stopped', tone: 'neutral', icon: <Square size={11} /> },
  waiting: { label: 'Waiting', tone: 'warn', icon: <Clock size={12} /> },
  crashed: { label: 'Crashed', tone: 'err', icon: <AlertTriangle size={12} /> },
};

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  const meta = statusMeta[status] ?? statusMeta.new;
  return (
    <Badge tone={meta.tone}>
      {meta.icon}
      {meta.label}
    </Badge>
  );
}

export function statusLabel(status: ExecutionStatus): string {
  return statusMeta[status]?.label ?? status;
}

export function Callout({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warn' | 'err' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'border-brand-line bg-brand-soft',
    warn: 'border-warn/40 bg-warn-soft',
    err: 'border-err/40 bg-err-soft',
    ok: 'border-ok/40 bg-ok-soft',
  };
  return (
    <div
      className={cx('rounded-lg border px-3 py-2 text-sm', tones[tone], className)}
      role={tone === 'err' ? 'alert' : undefined}
    >
      {title && <p className="font-semibold text-ink">{title}</p>}
      {children && <div className="text-ink-2">{children}</div>}
    </div>
  );
}
