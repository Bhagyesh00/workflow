/**
 * Expression editing: a CodeMirror field with `{{ }}` highlighting and `$` completion, plus a
 * live preview evaluated against the editor's latest run data.
 */
import { Braces } from 'lucide-react';
import { useDeferredValue, useMemo, useRef } from 'react';
import { CodeEditor, insertIntoEditor } from '../code/CodeEditor';
import { cx } from '../ui/cx';
import { FIELD_DRAG_TYPE, isExpressionValue, useParameterContext } from './context';

export function ExpressionPreview({ expression }: { expression: string }) {
  const ctx = useParameterContext();
  const deferred = useDeferredValue(expression);
  const result = useMemo(() => ctx.preview?.(deferred), [ctx, deferred]);
  if (!result) return null;
  const waiting = !result.ok && result.noInput;
  return (
    <div
      className={cx(
        'mt-1 rounded-md border px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap',
        result.ok || waiting ? 'border-line bg-surface-2' : 'border-err/30 bg-err-soft',
        result.ok ? 'text-ink-2' : waiting ? 'text-ink-3' : 'text-err',
      )}
      data-testid="expression-preview"
      data-state={result.ok ? 'result' : waiting ? 'waiting' : 'error'}
      aria-live="polite"
    >
      <span className="mr-1.5 font-sans font-semibold text-ink-3">
        {result.ok ? 'Result' : waiting ? 'Preview' : 'Error'}
      </span>
      <span className="max-h-40 overflow-auto">
        {result.ok ? result.text : waiting ? 'Execute previous nodes to preview' : result.error}
      </span>
      {waiting && <div className="mt-1 font-sans text-ink-3">{result.error}</div>}
      {!result.ok && !waiting && (result.code || result.hint) && (
        <div className="mt-1 font-sans text-ink-3">
          {result.code && <span className="mr-1.5 font-mono">{result.code}</span>}
          {result.hint}
        </div>
      )}
    </div>
  );
}

export function ExpressionInput({
  value,
  onChange,
  ariaLabel,
  rows = 1,
  showPreview = true,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  rows?: number;
  showPreview?: boolean;
}) {
  const ctx = useParameterContext();
  const hostRef = useRef<HTMLDivElement>(null);
  const text = isExpressionValue(value) ? value.slice(1) : value;
  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for dragged fields; the editor inside is the keyboard path */}
      <div
        ref={hostRef}
        className="wf-field wf-expression relative !p-0"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => {
          const dropped = event.dataTransfer.getData(FIELD_DRAG_TYPE);
          if (!dropped) return;
          event.preventDefault();
          event.stopPropagation();
          if (!insertIntoEditor(hostRef.current, dropped)) onChange(`=${text}${dropped}`);
        }}
      >
        <Braces
          size={12}
          className="pointer-events-none absolute top-2 right-2 text-brand"
          aria-hidden="true"
        />
        <CodeEditor
          language="expression"
          value={text}
          onChange={(next) => onChange(`=${next}`)}
          readOnly={ctx.readOnly}
          minRows={rows}
          maxHeight={240}
          completions={ctx.completions}
          ariaLabel={ariaLabel}
          className="pr-5"
        />
      </div>
      {showPreview && <ExpressionPreview expression={value} />}
    </div>
  );
}

/**
 * A text field that turns into an expression editor as soon as the value is an expression
 * (starts with `=`) or the user types `{{`. Used inside filters and assignments.
 */
export function SmartInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const ctx = useParameterContext();
  if (isExpressionValue(value) && ctx.allowExpressions) {
    return <ExpressionInput value={value} onChange={onChange} ariaLabel={ariaLabel} />;
  }
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return (
    <input
      className="wf-field"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={text}
      readOnly={ctx.readOnly}
      onChange={(event) => {
        const next = event.target.value;
        onChange(ctx.allowExpressions && next.includes('{{') ? `=${next}` : next);
      }}
      onDragOver={(event) => {
        if (ctx.allowExpressions && event.dataTransfer.types.includes(FIELD_DRAG_TYPE))
          event.preventDefault();
      }}
      onDrop={(event) => {
        const dropped = event.dataTransfer.getData(FIELD_DRAG_TYPE);
        if (!dropped || !ctx.allowExpressions) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(`=${text}${dropped}`);
      }}
    />
  );
}
