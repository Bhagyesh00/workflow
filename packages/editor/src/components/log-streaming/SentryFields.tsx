/** P6-64 (L8): the Sentry fields (the DSN; its public key shows blank once saved). Secret fields show blank with a "saved" hint. */
import type { ReactNode } from 'react';
import type { SentryDestinationSettings } from '../../api/types';

export interface SentryFieldsProps {
  value: SentryDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<SentryDestinationSettings>): void;
  disabled?: boolean;
}

// stub (L8)
export function SentryFields(_props: SentryFieldsProps): ReactNode {
  return null;
}
