import type { ReactNode } from 'react';
import { cx } from './cx';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  badge?: ReactNode;
}

/** Underline tabs; arrow keys move between tabs. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  size = 'md',
  label,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  size?: 'sm' | 'md';
  label: string;
}) {
  const onKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = items[(index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    onChange(next.value);
    const container = (event.currentTarget as HTMLElement).parentElement;
    requestAnimationFrame(() => container?.querySelector<HTMLElement>(`[data-tab="${next.value}"]`)?.focus());
  };
  return (
    <div role="tablist" aria-label={label} className={cx('flex items-end gap-4', className)}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            data-tab={item.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKey(e, index)}
            className={cx(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 font-semibold transition-colors',
              size === 'sm' ? 'pb-1.5 text-xs' : 'pb-2 text-sm',
              selected ? 'border-brand text-ink' : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

/** Compact pill switcher for view modes (Table / JSON / Schema). */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset aria-label={label} className="inline-flex rounded-lg border-0 bg-surface-3 p-0.5">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          aria-label={item.title}
          title={item.title}
          onClick={() => onChange(item.value)}
          className={cx(
            'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-semibold transition-colors',
            item.value === value ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
          )}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
