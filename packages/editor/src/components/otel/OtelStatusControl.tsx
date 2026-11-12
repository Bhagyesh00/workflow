/** P6-68 (L12): the status dot (on, off) with the enable control of the OpenTelemetry page. */
import type { ReactNode } from 'react';
import { Switch } from '../ui/Field';

export interface OtelStatusControlProps {
  enabled: boolean;
  onChange(enabled: boolean): void;
  disabled?: boolean;
}

export function OtelStatusControl({ enabled, onChange, disabled }: OtelStatusControlProps): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`size-2.5 rounded-full ${enabled ? 'bg-ok' : 'bg-line-strong'}`}
        data-status={enabled ? 'on' : 'off'}
      />
      <span className="text-sm font-semibold text-ink">{enabled ? 'Enabled' : 'Disabled'}</span>
      <Switch checked={enabled} onChange={onChange} label="Enable OpenTelemetry" disabled={disabled} />
    </div>
  );
}
