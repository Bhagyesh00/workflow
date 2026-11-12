/**
 * P6-68 (L12): the OTLP headers as rows (name, value) with add and remove, kept as n8n's `name=value,...` text
 * (`OtelSettings.exporterHeaders`). A saved value shows blank; a blank value keeps the saved one.
 */
import { type ReactNode, useRef, useState } from 'react';
import { newId } from '../../lib/ids';
import { Button, IconButton } from '../ui/Button';
import { TextInput } from '../ui/Field';

export interface OtelHeadersEditorProps {
  /** `exporterHeaders`: `name=value` entries separated by commas */
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
}

interface Row {
  key: string;
  name: string;
  value: string;
  /** the row came from a saved header: its value is stored on the server and shows blank */
  saved: boolean;
}

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? '' : part.slice(eq + 1).trim();
    rows.push({ key: newId(), name, value, saved: value === '' });
  }
  return rows;
}

/** rows with a name become `name=value`; a row with no name is not sent */
function serialize(rows: Row[]): string {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => `${row.name.trim()}=${row.value.trim()}`)
    .join(',');
}

export function OtelHeadersEditor({ value, onChange, disabled }: OtelHeadersEditorProps): ReactNode {
  const [rows, setRows] = useState<Row[]>(() => parseRows(value));
  const emitted = useRef(value);

  // a value that did not come from this editor (a save answered, the page reset) replaces the rows
  if (value !== emitted.current) {
    emitted.current = value;
    setRows(parseRows(value));
  }

  const update = (next: Row[]) => {
    setRows(next);
    const text = serialize(next);
    emitted.current = text;
    onChange(text);
  };
  const patch = (key: string, change: Partial<Row>) =>
    update(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.key} className="flex items-center gap-2">
          <TextInput
            aria-label={`Header name ${index + 1}`}
            placeholder="Name"
            value={row.name}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => patch(row.key, { name: e.target.value.replace(/[,=]/g, ''), saved: false })}
          />
          <TextInput
            aria-label={`Header value ${index + 1}`}
            type="password"
            placeholder={row.saved && row.value === '' ? 'Saved, leave blank to keep' : 'Value'}
            value={row.value}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => patch(row.key, { value: e.target.value.replace(/,/g, '') })}
          />
          <IconButton
            label={`Remove header ${row.name.trim() || index + 1}`}
            disabled={disabled}
            onClick={() => update(rows.filter((r) => r.key !== row.key))}
          >
            <span aria-hidden="true">×</span>
          </IconButton>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            setRows((current) => [...current, { key: newId(), name: '', value: '', saved: false }])
          }
        >
          Add header
        </Button>
      </div>
    </div>
  );
}
