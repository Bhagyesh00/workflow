/** P6-67 (L11): workflow settings slot: `settings.customTelemetryTags`, `workflow.custom.<key>` on the spans. */
import type { WorkflowSettings } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface WorkflowTelemetryTagsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

// stub (L11)
export function WorkflowTelemetryTags(_props: WorkflowTelemetryTagsProps): ReactNode {
  return null;
}
