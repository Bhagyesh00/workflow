/**
 * P6-85 (L17): the date range beside the custom data inputs of the executions list: runs started at or after
 * "Started after" and at or before "Started before". The values are ISO times (the list's query fields);
 * the inputs show them in the browser's local time.
 */
import type { ReactNode } from 'react';
import type { ExecutionListQuery } from '../../api/endpoints';
import { TextInput } from '../ui/Field';

export interface ExecutionFilterBarProps {
  value: ExecutionListQuery;
  onChange(next: ExecutionListQuery): void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** an ISO time as the local `YYYY-MM-DDTHH:mm` a datetime-local input shows; empty for no or a bad value */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** the local input text as an ISO time; undefined when it is empty or not a time */
function fromLocalInput(text: string): string | undefined {
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function ExecutionFilterBar({ value, onChange }: ExecutionFilterBarProps): ReactNode {
  const reversed =
    value.startedAfter !== undefined &&
    value.startedBefore !== undefined &&
    new Date(value.startedAfter).getTime() > new Date(value.startedBefore).getTime();
  const set = (key: 'startedAfter' | 'startedBefore', text: string) => {
    const next: ExecutionListQuery = { ...value };
    const iso = fromLocalInput(text);
    if (iso) next[key] = iso;
    else delete next[key];
    onChange(next);
  };
  return (
    <fieldset aria-label="Start time" className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <TextInput
        type="datetime-local"
        aria-label="Started after"
        title="Started after"
        className="w-48"
        value={toLocalInput(value.startedAfter)}
        max={toLocalInput(value.startedBefore) || undefined}
        onChange={(e) => set('startedAfter', e.target.value)}
      />
      <span aria-hidden="true" className="text-sm text-ink-3">
        to
      </span>
      <TextInput
        type="datetime-local"
        aria-label="Started before"
        title="Started before"
        className="w-48"
        value={toLocalInput(value.startedBefore)}
        min={toLocalInput(value.startedAfter) || undefined}
        onChange={(e) => set('startedBefore', e.target.value)}
      />
      {reversed && (
        <span role="alert" className="text-xs text-err">
          The start is after the end, so no run matches
        </span>
      )}
    </fieldset>
  );
}
