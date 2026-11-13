/** P6-64 (L8): the syslog fields (host, port, protocol, CA for TLS, facility, app name, line ending). */
import type { ReactNode } from 'react';
import type { SyslogDestinationSettings } from '../../api/types';
import { FormField, Select, TextArea, TextInput } from '../ui/Field';

export interface SyslogFieldsProps {
  value: SyslogDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<SyslogDestinationSettings>): void;
  disabled?: boolean;
}

/** n8n's facility list (RFC 5424 numbers) */
const FACILITIES: Array<[number, string]> = [
  [0, 'Kernel'],
  [1, 'User'],
  [3, 'System'],
  [13, 'Audit'],
  [14, 'Alert'],
  [16, 'Local0'],
  [17, 'Local1'],
  [18, 'Local2'],
  [19, 'Local3'],
  [20, 'Local4'],
  [21, 'Local5'],
  [22, 'Local6'],
  [23, 'Local7'],
];

const EOLS: Array<[string, string]> = [
  ['\n', 'LF'],
  ['\r\n', 'CRLF'],
];

export function SyslogFields({ value, onChange, disabled }: SyslogFieldsProps): ReactNode {
  const facilities = FACILITIES.some(([n]) => n === value.facility)
    ? FACILITIES
    : [...FACILITIES, [value.facility, `Facility ${value.facility}`] as [number, string]];
  const eols = EOLS.some(([e]) => e === value.eol)
    ? EOLS
    : [...EOLS, [value.eol, JSON.stringify(value.eol)] as [string, string]];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <FormField label="Host">
          {(id) => (
            <TextInput
              id={id}
              value={value.host}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => onChange({ host: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="Port">
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={1}
              max={65535}
              value={value.port}
              disabled={disabled}
              onChange={(e) => onChange({ port: Number(e.target.value) })}
            />
          )}
        </FormField>
      </div>
      <FormField label="Protocol">
        {(id) => (
          <Select
            id={id}
            value={value.protocol}
            disabled={disabled}
            onChange={(e) => onChange({ protocol: e.target.value as SyslogDestinationSettings['protocol'] })}
          >
            <option value="udp">UDP</option>
            <option value="tcp">TCP</option>
            <option value="tls">TLS</option>
          </Select>
        )}
      </FormField>
      {value.protocol === 'tls' && (
        <FormField
          label="CA certificate"
          hint="Required for TLS. Paste the PEM certificate of the authority that signed the server's certificate."
        >
          {(id) => (
            <TextArea
              id={id}
              rows={4}
              className="font-mono text-xs"
              value={value.tlsCa ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ tlsCa: e.target.value })}
            />
          )}
        </FormField>
      )}
      <FormField label="Facility">
        {(id) => (
          <Select
            id={id}
            value={String(value.facility)}
            disabled={disabled}
            onChange={(e) => onChange({ facility: Number(e.target.value) })}
          >
            {facilities.map(([number, name]) => (
              <option key={number} value={number}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="App name">
        {(id) => (
          <TextInput
            id={id}
            value={value.app_name}
            disabled={disabled}
            onChange={(e) => onChange({ app_name: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="End of line">
        {(id) => (
          <Select
            id={id}
            value={value.eol}
            disabled={disabled}
            onChange={(e) => onChange({ eol: e.target.value })}
          >
            {eols.map(([eol, name]) => (
              <option key={eol} value={eol}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </div>
  );
}
