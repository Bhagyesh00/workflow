/** P6-64 (L8): the syslog fields (host, port, protocol, TLS, facility, app name). Secret fields show blank with a "saved" hint. */
import type { ReactNode } from 'react';
import type { SyslogDestinationSettings } from '../../api/types';

export interface SyslogFieldsProps {
  value: SyslogDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<SyslogDestinationSettings>): void;
  disabled?: boolean;
}

// stub (L8)
export function SyslogFields(_props: SyslogFieldsProps): ReactNode {
  return null;
}
