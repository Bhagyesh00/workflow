/** P6-64 (L8): the webhook fields (URL, method, headers, query, body, TLS, redirects, timeout). Secret fields show blank with a "saved" hint. */
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WebhookDestinationSettings } from '../../api/types';
import { Button, IconButton } from '../ui/Button';
import { FormField, Select, Switch, TextInput } from '../ui/Field';

export interface WebhookFieldsProps {
  value: WebhookDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<WebhookDestinationSettings>): void;
  disabled?: boolean;
  /** the destination is saved: its secret values are kept on the server and show blank */
  saved?: boolean;
}

type Row = { name: string; value: string };

const SAVED_HINT = 'A saved value is kept when this stays blank.';

function Rows({
  noun,
  rows,
  onChange,
  disabled,
  saved,
}: {
  noun: 'header' | 'query parameter';
  rows: Row[];
  onChange(next: Row[]): void;
  disabled?: boolean;
  saved?: boolean;
}) {
  const cap = noun === 'header' ? 'Header' : 'Query parameter';
  const patch = (index: number, part: Partial<Row>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...part } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; the list only grows and shrinks by user action
        <div key={index} className="flex items-center gap-2">
          <TextInput
            aria-label={`${cap} name ${index + 1}`}
            placeholder="Name"
            value={row.name}
            disabled={disabled}
            onChange={(e) => patch(index, { name: e.target.value })}
          />
          <TextInput
            aria-label={`${cap} value ${index + 1}`}
            type="password"
            autoComplete="off"
            placeholder={saved && row.value === '' ? 'Saved' : 'Value'}
            value={row.value}
            disabled={disabled}
            onChange={(e) => patch(index, { value: e.target.value })}
          />
          <IconButton
            label={`Remove ${noun} ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}
      {saved && rows.some((row) => row.value === '') && <p className="text-xs text-ink-2">{SAVED_HINT}</p>}
      <div>
        <Button
          size="sm"
          icon={<Plus size={12} />}
          disabled={disabled}
          onClick={() => onChange([...rows, { name: '', value: '' }])}
        >
          {`Add ${noun}`}
        </Button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <div className="text-sm">
        <p className="font-semibold text-ink">{label}</p>
        {hint && <p className="text-ink-2">{hint}</p>}
      </div>
    </div>
  );
}

export function WebhookFields({ value, onChange, disabled, saved }: WebhookFieldsProps): ReactNode {
  const options = value.options;
  const setOptions = (patch: Partial<WebhookDestinationSettings['options']>) =>
    onChange({ options: { ...options, ...patch } });
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="URL"
        hint={saved ? `Query values in the URL are secret. ${SAVED_HINT}` : 'An http:// or https:// address.'}
      >
        {(id) => (
          <TextInput
            id={id}
            value={value.url}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => onChange({ url: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Method">
        {(id) => (
          <Select
            id={id}
            value={value.method}
            disabled={disabled}
            onChange={(e) => onChange({ method: e.target.value as WebhookDestinationSettings['method'] })}
          >
            {(['GET', 'POST', 'PUT', 'PATCH'] as const).map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <Toggle
        label="Send query parameters"
        checked={value.sendQuery}
        disabled={disabled}
        onChange={(sendQuery) => onChange({ sendQuery })}
      />
      {value.sendQuery && (
        <Rows
          noun="query parameter"
          rows={value.queryParameters}
          saved={saved}
          disabled={disabled}
          onChange={(queryParameters) => onChange({ queryParameters })}
        />
      )}
      <Toggle
        label="Send headers"
        checked={value.sendHeaders}
        disabled={disabled}
        onChange={(sendHeaders) => onChange({ sendHeaders })}
      />
      {value.sendHeaders && (
        <Rows
          noun="header"
          rows={value.headerParameters}
          saved={saved}
          disabled={disabled}
          onChange={(headerParameters) => onChange({ headerParameters })}
        />
      )}
      <Toggle
        label="Send payload"
        hint="The event is the body of the request. Off sends the request with no body."
        checked={value.sendPayload}
        disabled={disabled}
        onChange={(sendPayload) => onChange({ sendPayload })}
      />
      <Toggle
        label="Response code must match"
        hint="Any other status counts as a failed send."
        checked={value.responseCodeMustMatch}
        disabled={disabled}
        onChange={(responseCodeMustMatch) => onChange({ responseCodeMustMatch })}
      />
      {value.responseCodeMustMatch && (
        <FormField label="Expected status code">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={100}
              max={599}
              value={value.expectedStatusCode}
              disabled={disabled}
              onChange={(e) => onChange({ expectedStatusCode: Number(e.target.value) })}
            />
          )}
        </FormField>
      )}
      <Toggle
        label="Allow unauthorized certificates"
        hint="Skips the check of the server certificate. Use it only for a host you run yourself."
        checked={options.allowUnauthorizedCerts}
        disabled={disabled}
        onChange={(allowUnauthorizedCerts) => setOptions({ allowUnauthorizedCerts })}
      />
      <FormField label="Query array format">
        {(id) => (
          <Select
            id={id}
            value={options.queryParameterArrays}
            disabled={disabled}
            onChange={(e) =>
              setOptions({
                queryParameterArrays: e.target
                  .value as WebhookDestinationSettings['options']['queryParameterArrays'],
              })
            }
          >
            <option value="brackets">Brackets: a[]=1&amp;a[]=2</option>
            <option value="indices">Indices: a[0]=1&amp;a[1]=2</option>
            <option value="repeat">Repeat: a=1&amp;a=2</option>
          </Select>
        )}
      </FormField>
      <Toggle
        label="Follow redirects"
        hint="Off by default. Each redirect target is checked like the first address."
        checked={options.redirect.followRedirects}
        disabled={disabled}
        onChange={(followRedirects) => setOptions({ redirect: { ...options.redirect, followRedirects } })}
      />
      {options.redirect.followRedirects && (
        <FormField label="Max redirects">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={0}
              max={21}
              value={options.redirect.maxRedirects}
              disabled={disabled}
              onChange={(e) =>
                setOptions({ redirect: { ...options.redirect, maxRedirects: Number(e.target.value) } })
              }
            />
          )}
        </FormField>
      )}
      <FormField label="Timeout (ms)">
        {(id) => (
          <TextInput
            id={id}
            type="number"
            min={1}
            value={options.timeout}
            disabled={disabled}
            onChange={(e) => setOptions({ timeout: Number(e.target.value) })}
          />
        )}
      </FormField>
    </div>
  );
}
