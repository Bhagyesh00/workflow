import type { ComponentProps, ReactNode } from 'react';
import { cx } from './cx';
import { Spinner } from './misc';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:brightness-110 active:brightness-95 shadow-card',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-3',
  subtle: 'bg-surface-2 text-ink hover:bg-surface-3',
  danger: 'bg-err text-white hover:brightness-110',
};

const sizes = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-base gap-2 rounded-lg',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold whitespace-nowrap transition-[background,filter,border-color] disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ComponentProps<'button'> {
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary' | 'subtle';
  active?: boolean;
}

export function IconButton({
  label,
  size = 'md',
  variant = 'ghost',
  active,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-grid shrink-0 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        variant === 'secondary' &&
          'border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
        variant === 'subtle' && 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink',
        active && 'bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
