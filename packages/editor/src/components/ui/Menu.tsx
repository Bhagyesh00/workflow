import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from './cx';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  /** native tooltip, e.g. the reason an item is disabled */
  title?: string;
}

/** Click-to-open popover with arrow-key navigation. */
export function Menu({
  trigger,
  items,
  align = 'end',
  className,
  header,
  placement = 'bottom',
}: {
  trigger: (props: {
    open: boolean;
    toggle: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
  }) => ReactNode;
  items: Array<MenuItem | 'separator'>;
  align?: 'start' | 'end';
  className?: string;
  header?: ReactNode;
  placement?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const onListKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const nodes = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown' ? (index + 1) % nodes.length : (index - 1 + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          ref={listRef}
          role="menu"
          tabIndex={-1}
          onKeyDown={onListKey}
          className={cx(
            'absolute z-40 min-w-52 rounded-xl border border-line bg-surface p-1 shadow-lift',
            placement === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {header}
          {items.map((item, i) =>
            item === 'separator' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
              <hr key={`sep-${i}`} className="my-1 border-0 border-t border-line" />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none focus:bg-surface-3 hover:bg-surface-3 disabled:opacity-40',
                  item.danger ? 'text-err' : 'text-ink',
                )}
              >
                {item.icon && <span className="shrink-0 text-ink-2">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-xs text-ink-3">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** One menu row, shared with the right-click ContextMenu (P3-02): `onDone` runs before `onSelect`. */
export function MenuItemButton({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      title={item.title}
      onClick={() => {
        onDone();
        item.onSelect();
      }}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none focus:bg-surface-3 hover:bg-surface-3 disabled:opacity-40',
        item.danger ? 'text-err' : 'text-ink',
      )}
    >
      {item.icon && <span className="shrink-0 text-ink-2">{item.icon}</span>}
      <span className="flex-1">{item.label}</span>
      {item.hint && (
        <span aria-hidden="true" className="text-xs text-ink-3">
          {item.hint}
        </span>
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="my-1 border-0 border-t border-line" />;
}
