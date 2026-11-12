/** P6-67 (L11): workflow settings slot: `settings.customTelemetryTags`, `workflow.custom.<key>` on the spans. */
import type { WorkflowSettings } from '@workflow/workflow';
import type { ReactNode } from 'react';
import { TelemetryTagsField } from './TelemetryTagsField';

export interface WorkflowTelemetryTagsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

export function WorkflowTelemetryTags({ draft, set }: WorkflowTelemetryTagsProps): ReactNode {
  return (
    <TelemetryTagsField
      value={draft.customTelemetryTags ?? []}
      onChange={(next) => set({ customTelemetryTags: next.length > 0 ? next : undefined })}
      hint="Added to this workflow's spans as workflow.custom.<key> when the workspace sends traces."
    />
  );
}
