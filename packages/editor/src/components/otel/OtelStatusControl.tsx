/** P6-68 (L12): the status dot (on, off) with the enable control of the OpenTelemetry page. */
import type { ReactNode } from 'react';

export interface OtelStatusControlProps {
  enabled: boolean;
  onChange(enabled: boolean): void;
  disabled?: boolean;
}

// stub (L12)
export function OtelStatusControl(_props: OtelStatusControlProps): ReactNode {
  return null;
}
