/** P6-64 (L8): the Sentry fields (DSN, traces sample rate, send payload). The saved DSN shows without its key. */
import type { ReactNode } from 'react';
import type { SentryDestinationSettings } from '../../api/types';
import { FormField, Switch, TextInput } from '../ui/Field';

export interface SentryFieldsProps {
  value: SentryDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<SentryDestinationSettings>): void;
  disabled?: boolean;
  /** the destination is saved: the key of its DSN is kept on the server and shows blank */
  saved?: boolean;
}

export function SentryFields({ value, onChange, disabled, saved }: SentryFieldsProps): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="DSN"
        hint={
          saved
            ? 'The key of a saved DSN is hidden. A saved value is kept when the key stays blank and the host is unchanged.'
            : 'The project DSN from Sentry, with its key.'
        }
      >
        {(id) => (
          <TextInput
            id={id}
            value={value.dsn}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => onChange({ dsn: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Traces sample rate" hint="A number from 0 to 1. Leave it empty to send no traces.">
        {(id) => (
          <TextInput
            id={id}
            type="number"
            min={0}
            max={1}
            step={0.1}
            value={value.tracesSampleRate ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({ tracesSampleRate: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          />
        )}
      </FormField>
      <div className="flex items-start gap-3">
        <Switch
          checked={value.sendPayload}
          onChange={(sendPayload) => onChange({ sendPayload })}
          label="Send payload"
          disabled={disabled}
        />
        <div className="text-sm">
          <p className="font-semibold text-ink">Send payload</p>
          <p className="text-ink-2">Adds the event data to the Sentry message as extra data.</p>
        </div>
      </div>
    </div>
  );
}
