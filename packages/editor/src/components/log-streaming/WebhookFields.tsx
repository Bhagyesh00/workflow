/** P6-64 (L8): the webhook fields (URL, method, headers, query, body, TLS, redirects, timeout). Secret fields show blank with a "saved" hint. */
import type { ReactNode } from 'react';
import type { WebhookDestinationSettings } from '../../api/types';

export interface WebhookFieldsProps {
  value: WebhookDestinationSettings;
  /** merges a patch into `value` */
  onChange(patch: Partial<WebhookDestinationSettings>): void;
  disabled?: boolean;
}

// stub (L8)
export function WebhookFields(_props: WebhookFieldsProps): ReactNode {
  return null;
}
