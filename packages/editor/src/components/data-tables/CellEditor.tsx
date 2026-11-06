/**
 * How one cell of a data table reads and edits, per column type (P4-05). Null and empty text look
 * different, a very long value shows a message, and dates read and edit in UTC because that is how
 * they are stored and searched.
 */
import type { DataTableCellValue, DataTableColumnType } from '@workflow/workflow';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';
import { Select } from '../ui/Field';

/** above this many characters a cell shows a message instead of its value, as n8n */
export const LARGE_VALUE_CHARS = 10_000;

const dateInputValue = (value: DataTableCellValue) => (typeof value === 'string' ? value.slice(0, 19) : '');

export function CellValue({ value, type }: { value: DataTableCellValue; type: DataTableColumnType }) {
  if (value === null) return <span className="text-xs text-ink-3 italic">Null</span>;
  if (value === '') return <span className="text-xs text-ink-3 italic">Empty</span>;
  if (typeof value === 'boolean') return <span>{String(value)}</span>;
  if (type === 'date' && typeof value === 'string') {
    return <span title={`${value} (UTC)`}>{value.slice(0, 19).replace('T', ' ')}</span>;
  }
  const text = String(value);
  if (text.length > LARGE_VALUE_CHARS) {
    return <span className="text-xs text-ink-3 italic">Value too large to display</span>;
  }
  return <span className="block truncate">{text}</span>;
}

export function CellEditor({
  type,
  value,
  label,
  onCommit,
  onCancel,
}: {
  type: DataTableColumnType;
  value: DataTableCellValue;
  label: string;
  onCommit: (value: DataTableCellValue) => void;
  onCancel: () => void;
}) {
  const settled = useRef(false);
  const nullButton = useRef<HTMLButtonElement>(null);
  /** puts the cursor in the editor the moment it opens (a stable ref, so it runs once) */
  const focusOnOpen = useCallback((element: HTMLElement | null) => element?.focus(), []);
  const initial = type === 'date' ? dateInputValue(value) : value === null ? '' : String(value);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const settle = (run: () => void) => {
    if (settled.current) return;
    settled.current = true;
    run();
  };
  const cancel = () => settle(onCancel);
  const commit = (next: DataTableCellValue) => settle(() => onCommit(next));

  /** the typed value, or undefined when it is not one */
  const parsed = (): DataTableCellValue | undefined => {
    const text = draft.trim();
    if (type === 'string') return draft;
    if (!text) return null;
    if (type === 'number') {
      const number = Number(text);
      return Number.isFinite(number) ? number : undefined;
    }
    const date = new Date(`${text}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };

  const save = (fromBlur: boolean) => {
    if (draft === initial) {
      cancel();
      return;
    }
    const next = parsed();
    if (next !== undefined) {
      commit(next);
    } else if (fromBlur) {
      cancel();
    } else {
      setError(type === 'number' ? 'Enter a number' : 'Enter a date');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save(false);
    }
  };

  const field = 'wf-field min-w-32 py-1 text-sm';
  const number = type === 'number' ? Number(draft) : Number.NaN;

  if (type === 'boolean') {
    return (
      <Select
        autoFocus
        aria-label={label}
        className={field}
        value={value === null ? 'null' : String(value)}
        onBlur={cancel}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') cancel();
        }}
        onChange={(event) => {
          const next = event.target.value;
          commit(next === 'null' ? null : next === 'true');
        }}
      >
        <option value="null">Null</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {type === 'string' ? (
        <textarea
          ref={focusOnOpen}
          aria-label={label}
          rows={1}
          className={`${field} resize-y`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            // Tab reaches "Set to null"; leaving that button saves
            if (event.relatedTarget !== nullButton.current) save(true);
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          ref={focusOnOpen}
          aria-label={label}
          aria-invalid={Boolean(error)}
          type={type === 'date' ? 'datetime-local' : 'text'}
          step={type === 'date' ? 1 : undefined}
          inputMode={type === 'number' ? 'decimal' : undefined}
          className={field}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={() => save(true)}
          onKeyDown={onKeyDown}
        />
      )}
      {error && (
        <p className="text-xs text-err" role="alert">
          {error}
        </p>
      )}
      {Math.abs(number) > Number.MAX_SAFE_INTEGER && (
        <p className="text-xs text-warn">Numbers above 9,007,199,254,740,991 can lose precision</p>
      )}
      {type === 'string' && (
        <button
          ref={nullButton}
          type="button"
          className="self-start text-xs font-semibold text-ink-2 hover:text-ink"
          // keeps the focus in the text box, so its blur does not save first
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit(null)}
          onBlur={() => save(true)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') cancel();
          }}
        >
          Set to null
        </button>
      )}
    </div>
  );
}
