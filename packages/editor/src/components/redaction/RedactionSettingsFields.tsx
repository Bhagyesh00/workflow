/**
 * P6-53 (L8): workflow settings fields: redact production runs, manual runs, and callers' copies
 * (`redactionPolicy`, `redactCallerExecutions`); never weaker than the workspace floor.
 */

import type { WorkflowSettings } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface RedactionSettingsFieldsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

/** stub (L8): renders nothing until L8 draws it */
export function RedactionSettingsFields(_props: RedactionSettingsFieldsProps): ReactNode {
  return null;
}
