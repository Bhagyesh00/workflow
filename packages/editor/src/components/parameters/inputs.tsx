/** Inputs for the scalar parameter types. */
import { useQuery } from '@tanstack/react-query';
import {
  isOption,
  type NodeProperty,
  type NodePropertyOption,
  resolveNodeParameters,
} from '@workflow/workflow';
import { Check, ChevronDown, Eye, EyeOff, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { nodeTypesApi } from '../../api/endpoints';
import { useCredentialTypes } from '../../api/queries';
import { REDACTED } from '../../api/types';
import { getIn } from '../../lib/workflow-ops';
import { CodeEditor } from '../code/CodeEditor';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Select, Switch } from '../ui/Field';
import { Callout } from '../ui/misc';
import { useParameterContext } from './context';

export interface InputProps<T = unknown> {
  prop: NodeProperty;
  value: T;
  onChange: (value: unknown) => void;
  id: string;
}

export function StringInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const [reveal, setReveal] = useState(false);
  const rows = prop.typeOptions?.rows ?? 1;
  const text = value === undefined || value === null ? '' : String(value);
  if (rows > 1) {
    return (
      <textarea
        id={id}
        className="wf-field resize-y"
        rows={rows}
        value={text}
        placeholder={prop.placeholder}
        readOnly={ctx.readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (prop.typeOptions?.password) {
    // the server returns stored secrets as a sentinel; sending it back keeps the stored value
    const redacted = text === REDACTED;
    return (
      <div className="relative">
        <input
          id={id}
          className="wf-field pr-9"
          type={reveal ? 'text' : 'password'}
          autoComplete="new-password"
          value={redacted ? '' : text}
          placeholder={redacted ? 'Saved. Type to replace it.' : prop.placeholder}
          readOnly={ctx.readOnly}
          data-redacted={redacted || undefined}
          onChange={(e) => {
            const next = e.target.value;
            // typing `{{` makes the field an expression (a credential field reading `$secrets`), which then shows its text
            if (ctx.allowExpressions && !prop.noDataExpression && next.includes('{{'))
              return onChange(`=${next}`);
            onChange(next === '' && ctx.keepSecretOnEmpty ? REDACTED : next);
          }}
        />
        <button
          type="button"
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-3 hover:text-ink"
          aria-label={reveal ? 'Hide value' : 'Show value'}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    );
  }
  return (
    <input
      id={id}
      className="wf-field"
      value={text}
      placeholder={prop.placeholder}
      readOnly={ctx.readOnly}
      onChange={(e) => {
        const next = e.target.value;
        // typing `{{` switches the field to an expression, like the expression toggle
        onChange(ctx.allowExpressions && !prop.noDataExpression && next.includes('{{') ? `=${next}` : next);
      }}
    />
  );
}

export function NumberInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const precision = prop.typeOptions?.numberPrecision;
  const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => {
    setDraft((d) => (Number(d) === value ? d : value === undefined || value === null ? '' : String(value)));
  }, [value]);
  const min = prop.typeOptions?.minValue;
  const max = prop.typeOptions?.maxValue;
  const invalid =
    draft !== '' &&
    (Number.isNaN(Number(draft)) ||
      (min !== undefined && Number(draft) < min) ||
      (max !== undefined && Number(draft) > max));
  return (
    <div>
      <input
        id={id}
        className="wf-field"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={precision !== undefined ? 10 ** -precision : 'any'}
        value={draft}
        placeholder={prop.placeholder}
        readOnly={ctx.readOnly}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value === '') return onChange(undefined);
          let n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          if (precision !== undefined) n = Number(n.toFixed(precision));
          onChange(n);
        }}
      />
      {invalid && (
        <p className="mt-1 text-xs text-err">
          {min !== undefined && max !== undefined
            ? `Enter a number between ${min} and ${max}`
            : min !== undefined
              ? `Enter a number of at least ${min}`
              : max !== undefined
                ? `Enter a number of at most ${max}`
                : 'Enter a number'}
        </p>
      )}
    </div>
  );
}

export function BooleanInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  return (
    <Switch
      id={id}
      checked={Boolean(value)}
      onChange={(checked) => onChange(checked)}
      label={prop.displayName}
      disabled={ctx.readOnly}
    />
  );
}

/** Values of the parameters named in `loadOptionsDependsOn` (dotted paths from the root). */
function useDependsOnValues(prop: NodeProperty): unknown[] {
  const ctx = useParameterContext();
  return (prop.typeOptions?.loadOptionsDependsOn ?? []).map((path) =>
    getIn(ctx.rootValues, path.replace(/^\//, '').split('.')),
  );
}

/** Options of `prop`: static, or loaded via POST /node-types/options (kind loadOptions). */
export function useOptions(prop: NodeProperty): {
  options: NodePropertyOption[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const ctx = useParameterContext();
  const method = prop.typeOptions?.loadOptionsMethod;
  const dependsOn = useDependsOnValues(prop);
  const query = useQuery({
    queryKey: [
      'load-options',
      ctx.node.type,
      method,
      ctx.node.name,
      JSON.stringify(dependsOn),
      JSON.stringify(ctx.node.credentials ?? {}),
    ],
    enabled: Boolean(method && ctx.description),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      nodeTypesApi.loadOptions({
        nodeType: ctx.node.type,
        method: method!,
        kind: 'loadOptions',
        node: {
          ...ctx.node,
          parameters: ctx.description
            ? resolveNodeParameters(ctx.description.properties, ctx.node.parameters, {
                nodeVersion: ctx.node.typeVersion,
              })
            : ctx.node.parameters,
        },
      }),
  });
  const staticOptions = useMemo(() => (prop.options ?? []).filter(isOption), [prop.options]);
  if (!method) return { options: staticOptions, isLoading: false, error: null, refetch: () => undefined };
  return {
    options: Array.isArray(query.data) ? query.data : [],
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => void query.refetch(),
  };
}

export function OptionsInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const { options, isLoading, error, refetch } = useOptions(prop);
  const index = options.findIndex((o) => o.value === value);
  const selected = options[index];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Select
          id={id}
          className="flex-1"
          value={index === -1 ? '' : String(index)}
          disabled={ctx.readOnly || isLoading}
          onChange={(e) => {
            const option = options[Number(e.target.value)];
            if (option) onChange(option.value);
          }}
        >
          {index === -1 && (
            <option value="" disabled>
              {isLoading
                ? 'Loading options…'
                : value === undefined || value === ''
                  ? 'Choose…'
                  : String(value)}
            </option>
          )}
          {options.map((o, i) => (
            <option key={`${String(o.value)}-${o.name}`} value={String(i)}>
              {o.name}
            </option>
          ))}
        </Select>
        {prop.typeOptions?.loadOptionsMethod && (
          <button
            type="button"
            onClick={refetch}
            aria-label="Reload options"
            title="Reload options"
            className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-3"
          >
            <RefreshCw size={14} className={isLoading ? 'wf-spinner' : undefined} />
          </button>
        )}
      </div>
      {selected?.description && <p className="text-xs text-ink-3">{selected.description}</p>}
      {error && <p className="text-xs text-err">Could not load options: {error}</p>}
    </div>
  );
}

export function MultiOptionsInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const { options, isLoading, error } = useOptions(prop);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = Array.isArray(value) ? value : [];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const toggle = (v: unknown) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        disabled={ctx.readOnly}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="wf-field flex min-h-9 flex-wrap items-center gap-1 text-left"
      >
        {selected.length === 0 && <span className="text-ink-3">{isLoading ? 'Loading…' : 'Choose…'}</span>}
        {selected.map((v) => (
          <span
            key={String(v)}
            className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-semibold text-brand"
          >
            {options.find((o) => o.value === v)?.name ?? String(v)}
          </span>
        ))}
        <ChevronDown size={14} className="ml-auto text-ink-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="wf-scroll absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-line bg-surface p-1 shadow-lift"
        >
          {options.map((o) => {
            const isSelected = selected.includes(o.value);
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                key={`${String(o.value)}-${o.name}`}
                onClick={() => toggle(o.value)}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3"
              >
                <span
                  className={cx(
                    'mt-0.5 grid size-4 shrink-0 place-items-center rounded border',
                    isSelected ? 'border-brand bg-brand text-on-brand' : 'border-line-strong',
                  )}
                >
                  {isSelected && <Check size={11} />}
                </span>
                <span>
                  <span className="block">{o.name}</span>
                  {o.description && <span className="block text-xs text-ink-3">{o.description}</span>}
                </span>
              </button>
            );
          })}
          {!options.length && <p className="px-2 py-1.5 text-sm text-ink-3">No options</p>}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-err">Could not load options: {error}</p>}
    </div>
  );
}

export function ColorInput({ value, onChange, id, prop }: InputProps) {
  const ctx = useParameterContext();
  const text = typeof value === 'string' ? value : '';
  const valid = /^#[0-9a-f]{6}$/i.test(text);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${prop.displayName} picker`}
        value={valid ? text : '#000000'}
        disabled={ctx.readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-11 cursor-pointer rounded-lg border border-line bg-surface p-1"
      />
      <input
        id={id}
        className="wf-field font-mono"
        value={text}
        placeholder="#000000"
        readOnly={ctx.readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function toLocalInput(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DateTimeInput({ value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  return (
    <input
      id={id}
      type="datetime-local"
      className="wf-field"
      value={toLocalInput(value)}
      readOnly={ctx.readOnly}
      onChange={(e) => {
        if (!e.target.value) return onChange('');
        const date = new Date(e.target.value);
        if (!Number.isNaN(date.getTime())) onChange(date.toISOString());
      }}
    />
  );
}

export function JsonInput({ prop, value, onChange }: InputProps) {
  const ctx = useParameterContext();
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  const error = useMemo(() => {
    if (!text.trim()) return null;
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [text]);
  return (
    <div>
      <div className="wf-field !p-0">
        <CodeEditor
          language="json"
          value={text}
          onChange={(next) => onChange(next)}
          readOnly={ctx.readOnly}
          minRows={prop.typeOptions?.rows ?? 5}
          maxHeight={420}
          lineNumbers
          ariaLabel={prop.displayName}
        />
      </div>
      {error && <p className="mt-1 text-xs text-err">Invalid JSON: {error}</p>}
    </div>
  );
}

export function CodeInput({ prop, value, onChange }: InputProps) {
  const ctx = useParameterContext();
  const editorLanguage = prop.typeOptions?.editorLanguage;
  const language = editorLanguage === 'json' ? 'json' : editorLanguage === 'python' ? 'python' : 'javascript';
  return (
    <div className="wf-field !p-0">
      <CodeEditor
        language={language}
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange(next)}
        readOnly={ctx.readOnly}
        minRows={prop.typeOptions?.rows ?? 10}
        maxHeight={560}
        lineNumbers
        completions={ctx.completions}
        ariaLabel={prop.displayName}
      />
    </div>
  );
}

export function NoticeInput({ prop }: { prop: NodeProperty }) {
  return <Callout tone="info">{prop.displayName}</Callout>;
}

export function ButtonInput({ prop }: { prop: NodeProperty }) {
  const ctx = useParameterContext();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="subtle"
        disabled={ctx.readOnly || !ctx.onButton}
        onClick={() => ctx.onButton?.(prop)}
      >
        {prop.displayName}
      </Button>
      {prop.description && <p className="text-xs text-ink-3">{prop.description}</p>}
    </div>
  );
}

/** Picks a credential *type* (e.g. the generic auth type of an HTTP request). */
export function CredentialsSelectInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const credentialTypes = useCredentialTypes();
  const allowed = (prop.options ?? []).filter(isOption).map((o) => String(o.value));
  const choices = credentialTypes.list.filter((t) =>
    allowed.length ? allowed.includes(t.name) : t.hasAuthenticate || t.isOAuth2,
  );
  return (
    <Select
      id={id}
      value={typeof value === 'string' ? value : ''}
      disabled={ctx.readOnly}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Choose a credential type…</option>
      {choices.map((t) => (
        <option key={t.name} value={t.name}>
          {t.displayName}
        </option>
      ))}
    </Select>
  );
}

export function ClearButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-err"
    >
      <X size={14} />
    </button>
  );
}
