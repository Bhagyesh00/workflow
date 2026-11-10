/** The card every settings page is built from: a titled section with an optional action. */
import type { ReactNode } from 'react';

export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <div className="flex-1">
          <h2 className="text-md font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
