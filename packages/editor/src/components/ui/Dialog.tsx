import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Button } from './Button';
import { cx } from './cx';

const stack: string[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), .cm-content';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** keep Escape / backdrop from closing (e.g. while saving) */
  dismissible?: boolean;
  className?: string;
  bodyClassName?: string;
}

const widths = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[min(1600px,96vw)] h-[92vh]',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  className,
  bodyClassName,
}: DialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key === 'Tab' && panel) {
        const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.offsetParent !== null,
        );
        if (!focusable.length) return;
        const firstEl = focusable[0];
        const lastEl = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === firstEl) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
      previous?.focus?.();
    };
  }, [open, id, dismissible]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[color-mix(in_oklab,var(--wf-ink)_38%,transparent)] p-4 pt-[6vh] backdrop-blur-[2px]">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="fixed inset-0 cursor-default"
        onClick={() => dismissible && onClose()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={cx(
          'relative flex w-full flex-col rounded-2xl border border-line bg-surface shadow-lift outline-none',
          widths[size],
          className,
        )}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={`${id}-desc`} className="mt-0.5 text-sm text-ink-2">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className={cx('min-h-0 flex-1 px-5 py-4', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------
// Imperative confirm
// ---------------------------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  open(options: ConfirmOptions): Promise<boolean>;
  settle(ok: boolean): void;
}

const useConfirmStore = create<ConfirmState>()((set, get) => ({
  request: null,
  open(options) {
    get().request?.resolve(false);
    return new Promise<boolean>((resolve) => set({ request: { ...options, resolve } }));
  },
  settle(ok) {
    get().request?.resolve(ok);
    set({ request: null });
  },
}));

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(options);
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);
  return (
    <Dialog
      open={Boolean(request)}
      onClose={() => settle(false)}
      title={request?.title ?? ''}
      size="sm"
      footer={
        <>
          <Button onClick={() => settle(false)}>{request?.cancelLabel ?? 'Cancel'}</Button>
          <Button
            variant={request?.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => settle(true)}
            data-autofocus
          >
            {request?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {request?.description && <div className="text-sm text-ink-2">{request.description}</div>}
    </Dialog>
  );
}
