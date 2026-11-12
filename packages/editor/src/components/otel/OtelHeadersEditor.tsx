/**
 * P6-68 (L12): the OTLP headers as rows (name, value) with add and remove, kept as n8n's `name=value,...` text
 * (`OtelSettings.exporterHeaders`). A saved value shows blank; a blank value keeps the saved one.
 */
import type { ReactNode } from 'react';

export interface OtelHeadersEditorProps {
  /** `exporterHeaders`: `name=value` entries separated by commas */
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
}

// stub (L12)
export function OtelHeadersEditor(_props: OtelHeadersEditorProps): ReactNode {
  return null;
}
