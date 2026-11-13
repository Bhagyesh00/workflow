/**
 * P6-67 (L11): custom OpenTelemetry attributes as key and value rows with add and remove; refuses an empty or
 * a duplicate key (workflow's `validateTelemetryTags`, `TELEMETRY_TAG_LIMITS`).
 *
 * The rows are kept here while they are edited. A list is passed to `onChange` only when it is valid: a row with
 * a value and no key, a repeated key or a list over the limit shows its reason and is not passed on, so the page
 * that saves never holds an invalid list. A row that is still blank is ignored.
 *
 * `onValidityChange(true)` tells the page that the rows on screen are not the list it holds, so it can disable its
 * Save (n8n does); it reports `false` again when the rows are valid and when the field goes away.
 */
import { TELEMETRY_TAG_LIMITS, validateTelemetryTags } from '@workflow/workflow';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { TelemetryTag } from '../../api/types';
import { Button, IconButton } from '../ui/Button';
import { TextInput } from '../ui/Field';

export interface TelemetryTagsFieldProps {
  value: TelemetryTag[];
  onChange(next: TelemetryTag[]): void;
  /** true while a row is invalid (the list `onChange` last got is not what the rows show), false otherwise */
  onValidityChange?(invalid: boolean): void;
  disabled?: boolean;
  /** the field's title (default "Custom telemetry attributes") */
  label?: string;
  /** one line under the title: where the attributes go */
  hint?: ReactNode;
  /** placeholder of the value inputs */
  valuePlaceholder?: string;
}

interface Row extends TelemetryTag {
  id: number;
}

const signature = (tags: TelemetryTag[]): string => JSON.stringify(tags.map((t) => [t.key, t.value]));

/** the list a set of rows stands for: blank rows left out, keys trimmed */
function listOf(rows: Row[]): TelemetryTag[] {
  return rows
    .filter((row) => !(row.key.trim() === '' && row.value === ''))
    .map((row) => ({ key: row.key.trim(), value: row.value }));
}

export function TelemetryTagsField({
  value,
  onChange,
  onValidityChange,
  disabled,
  label = 'Custom telemetry attributes',
  hint,
  valuePlaceholder,
}: TelemetryTagsFieldProps): ReactNode {
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    value.map((t) => ({ id: nextId.current++, key: t.key, value: t.value })),
  );
  // the list this field last passed on (or took from outside): a different `value` is a change from outside
  const last = useRef(signature(value));

  useEffect(() => {
    const incoming = signature(value);
    if (incoming === last.current) return;
    last.current = incoming;
    setRows(value.map((t) => ({ id: nextId.current++, key: t.key, value: t.value })));
  }, [value]);

  const problem = useMemo(() => validateTelemetryTags(listOf(rows)), [rows]);

  // the page's callback is read through a ref, so an inline function does not fire the effect on every render
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  const invalid = problem !== null;
  useEffect(() => {
    validity.current?.(invalid);
  }, [invalid]);
  useEffect(
    () => () => {
      validity.current?.(false);
    },
    [],
  );

  const update = (next: Row[]) => {
    setRows(next);
    const list = listOf(next);
    if (validateTelemetryTags(list) !== null) return;
    const sig = signature(list);
    if (sig === last.current) return;
    last.current = sig;
    onChange(list);
  };

  const patchRow = (id: number, patch: Partial<TelemetryTag>) =>
    update(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <fieldset className="flex flex-col gap-2 rounded-xl border border-line p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
      {rows.length === 0 && <p className="text-xs text-ink-2">No attributes yet.</p>}
      {rows.map((row, i) => (
        <div key={row.id} className="flex items-center gap-2">
          <TextInput
            aria-label={`Key ${i + 1}`}
            placeholder="Key"
            maxLength={TELEMETRY_TAG_LIMITS.keyLength}
            value={row.key}
            disabled={disabled}
            onChange={(e) => patchRow(row.id, { key: e.target.value })}
          />
          <TextInput
            aria-label={`Value ${i + 1}`}
            placeholder={valuePlaceholder ?? 'Value'}
            maxLength={TELEMETRY_TAG_LIMITS.valueLength}
            value={row.value}
            disabled={disabled}
            onChange={(e) => patchRow(row.id, { value: e.target.value })}
          />
          <IconButton
            label={`Remove attribute ${i + 1}`}
            size="sm"
            disabled={disabled}
            onClick={() => update(rows.filter((r) => r.id !== row.id))}
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      {problem && (
        <p className="text-xs text-err" role="alert">
          {problem}
        </p>
      )}
      <div>
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          disabled={disabled || rows.length >= TELEMETRY_TAG_LIMITS.max}
          onClick={() => setRows([...rows, { id: nextId.current++, key: '', value: '' }])}
        >
          Add attribute
        </Button>
      </div>
    </fieldset>
  );
}
