/**
 * P6-67 (L11): custom OpenTelemetry attributes as key and value rows with add and remove; refuses an empty or
 * a duplicate key (workflow's `validateTelemetryTags`, `TELEMETRY_TAG_LIMITS`).
 */
import type { ReactNode } from 'react';
import type { TelemetryTag } from '../../api/types';

export interface TelemetryTagsFieldProps {
  value: TelemetryTag[];
  onChange(next: TelemetryTag[]): void;
  disabled?: boolean;
}

// stub (L11)
export function TelemetryTagsField(_props: TelemetryTagsFieldProps): ReactNode {
  return null;
}
