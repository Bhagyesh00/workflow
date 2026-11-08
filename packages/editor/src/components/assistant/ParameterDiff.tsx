/**
 * P5-62: `before` and `after` of every value change of one node, as text (URLs and code stay
 * visible to the reviewer), long values collapsed behind "Show all".
 */
import type { NodeChange, ValueChange } from '@workflow/workflow';
import { useState } from 'react';

export interface ParameterDiffProps {
  change: NodeChange;
}

/** a value longer than this many characters, or lines, starts collapsed */
const COLLAPSED_CHARS = 200;
const COLLAPSED_LINES = 6;

/** a value as the reviewer reads it: strings as they are, everything else as indented JSON */
function asText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

/** `parameters.options.timeout` -> `options.timeout` */
function label(path: string): string {
  return path.replace(/^parameters\./, '');
}

function Value({ caption, value, tone }: { caption: string; value: unknown; tone: 'before' | 'after' }) {
  const [expanded, setExpanded] = useState(false);
  const text = asText(value);
  const lines = text.split('\n');
  const long = text.length > COLLAPSED_CHARS || lines.length > COLLAPSED_LINES;
  const shown =
    long && !expanded ? `${lines.slice(0, COLLAPSED_LINES).join('\n').slice(0, COLLAPSED_CHARS)}…` : text;
  return (
    <div className="min-w-0">
      <span
        className={tone === 'before' ? 'text-2xs font-semibold text-err' : 'text-2xs font-semibold text-ok'}
      >
        {caption}
      </span>
      {text === '' ? (
        <p className="text-xs text-ink-3 italic">(none)</p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-md bg-surface-3 px-2 py-1 font-mono text-2xs whitespace-pre-wrap break-all text-ink">
          {shown}
        </pre>
      )}
      {long && (
        <button
          type="button"
          className="mt-0.5 text-2xs font-semibold text-brand hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all (${text.length} characters)`}
        </button>
      )}
    </div>
  );
}

function Row({ change }: { change: ValueChange }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="font-mono text-2xs text-ink-2">{label(change.path)}</span>
      <div className="grid grid-cols-1 gap-1">
        <Value caption="Before" value={change.before} tone="before" />
        <Value caption="After" value={change.after} tone="after" />
      </div>
    </li>
  );
}

export function ParameterDiff({ change }: ParameterDiffProps) {
  if (!change.changes.length) return null;
  return (
    <fieldset
      aria-label={`Changes to ${change.name}`}
      className="min-w-0 rounded-lg border border-line bg-surface px-2.5 py-2"
    >
      <legend className="sr-only">{change.name}</legend>
      <p className="mb-1.5 text-xs font-semibold text-ink">{change.name}</p>
      <ul className="flex flex-col gap-2">
        {change.changes.map((c) => (
          <Row key={c.path} change={c} />
        ))}
      </ul>
    </fieldset>
  );
}
