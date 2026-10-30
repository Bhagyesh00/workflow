/**
 * Sign-in / sign-up frame. The right side shows a small patch bay: three modules wired with
 * cables and one signal travelling through them, the product's visual idea in one picture.
 */
import type { ReactNode } from 'react';
import { BrandMark } from '../../components/shell/BrandMark';

function PatchBay() {
  const cable1 = 'M 168 120 C 250 120, 250 250, 330 250';
  const cable2 = 'M 448 250 C 520 250, 520 120, 600 120';
  const cable3 = 'M 448 266 C 530 266, 520 380, 600 380';
  const modules = [
    { x: 40, y: 88, label: 'New order', sub: 'Webhook', trigger: true },
    { x: 330, y: 218, label: 'Check stock', sub: 'HTTP request' },
    { x: 600, y: 88, label: 'Notify team', sub: 'Send message' },
    { x: 600, y: 348, label: 'Create invoice', sub: 'Accounting' },
  ];
  return (
    <svg
      viewBox="0 0 760 470"
      className="h-auto w-full max-w-[640px]"
      role="img"
      aria-label="Three connected workflow steps"
    >
      <defs>
        <pattern id="wf-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.4" fill="var(--wf-grid)" />
        </pattern>
      </defs>
      <rect width="760" height="470" fill="url(#wf-dots)" />
      {[cable1, cable2, cable3].map((d) => (
        <path key={d} d={d} fill="none" stroke="var(--wf-cable)" strokeWidth="2.5" strokeLinecap="round" />
      ))}
      <path
        d={cable1}
        fill="none"
        stroke="var(--wf-brand)"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="wf-auth-signal"
        pathLength={100}
      />
      <path
        d={cable2}
        fill="none"
        stroke="var(--wf-brand)"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="wf-auth-signal wf-auth-signal-2"
        pathLength={100}
      />
      {modules.map((m) => (
        <g key={m.label} transform={`translate(${m.x} ${m.y})`}>
          <rect
            width="128"
            height="64"
            rx="12"
            fill="var(--wf-surface)"
            stroke="var(--wf-line-strong)"
            strokeWidth="1.5"
          />
          {m.trigger && <rect width="6" height="64" rx="3" fill="var(--wf-brand)" />}
          <rect
            x="14"
            y="14"
            width="36"
            height="36"
            rx="9"
            fill="color-mix(in oklab, var(--wf-brand) 14%, var(--wf-surface))"
          />
          <text
            x="58"
            y="30"
            fontSize="12"
            fontWeight="650"
            fill="var(--wf-ink)"
            fontFamily="var(--font-sans)"
          >
            {m.label}
          </text>
          <text x="58" y="46" fontSize="10.5" fill="var(--wf-ink-2)" fontFamily="var(--font-sans)">
            {m.sub}
          </text>
          {!m.trigger && (
            <circle
              cx="0"
              cy="32"
              r="6"
              fill="var(--wf-surface)"
              stroke="var(--wf-line-strong)"
              strokeWidth="2"
            />
          )}
          <circle
            cx="128"
            cy="32"
            r="6"
            fill="var(--wf-surface)"
            stroke="var(--wf-line-strong)"
            strokeWidth="2"
          />
        </g>
      ))}
    </svg>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(420px,520px)_1fr]">
      <style>{`
        .wf-auth-signal { stroke-dasharray: 12 88; stroke-dashoffset: 100; animation: wf-auth-flow 2.8s cubic-bezier(.6,0,.4,1) infinite; }
        .wf-auth-signal-2 { animation-delay: 1.1s; }
        @keyframes wf-auth-flow { 0% { stroke-dashoffset: 100; opacity: 0 } 10% { opacity: 1 } 60% { stroke-dashoffset: 0; opacity: 1 } 70%, 100% { stroke-dashoffset: 0; opacity: 0 } }
        @media (prefers-reduced-motion: reduce) { .wf-auth-signal { animation: none; stroke-dasharray: none; opacity: .9 } }
      `}</style>
      <section className="flex flex-col bg-surface px-8 py-8 sm:px-14">
        <BrandMark />
        <div className="my-auto w-full max-w-sm py-12">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-2 text-base text-ink-2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        {footer && <div className="text-sm text-ink-2">{footer}</div>}
      </section>
      <aside
        className="hidden items-center justify-center border-l border-line bg-paper p-10 lg:flex"
        aria-hidden="true"
      >
        <PatchBay />
      </aside>
    </div>
  );
}
