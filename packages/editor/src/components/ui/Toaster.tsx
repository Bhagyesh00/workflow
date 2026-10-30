import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { type Toast, useToastStore } from '../../stores/ui-store';
import { cx } from './cx';

function ToastView({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, dismiss]);
  const icon =
    toast.kind === 'success' ? (
      <CheckCircle2 size={16} className="text-ok" />
    ) : toast.kind === 'error' ? (
      <XCircle size={16} className="text-err" />
    ) : (
      <Info size={16} className="text-brand" />
    );
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex w-80 items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-lift',
        toast.kind === 'error' && 'border-err/40',
      )}
    >
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-xs break-words text-ink-2">{toast.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
        className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} />
      ))}
    </div>
  );
}
