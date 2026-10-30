import { ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { cx } from './cx';

export function TextInput({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx('wf-field', className)} {...rest} />;
}

export function TextArea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx('wf-field resize-y', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <div className={cx('relative', className)}>
      <select className="wf-field appearance-none pr-8" {...rest}>
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3"
        aria-hidden="true"
      />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = 'md',
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-4.5 w-8' : 'h-5.5 w-10',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'inline-block rounded-full bg-white shadow transition-transform',
          size === 'sm' ? 'size-3.5' : 'size-4.5',
          checked ? (size === 'sm' ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Checkbox({ label, className, ...rest }: ComponentProps<'input'> & { label: ReactNode }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="size-4 accent-[var(--wf-brand)]" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** Label + control + hint/error, wiring ids for accessibility. */
export function FormField({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
        {required && <span className="ml-0.5 text-err">*</span>}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs text-err" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-ink-2">{hint}</p>
      )}
    </div>
  );
}
