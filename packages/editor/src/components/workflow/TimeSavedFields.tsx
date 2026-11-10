/**
 * P6-56 (L12): workflow settings fields: time saved per run, Fixed (`timeSavedPerExecution`) or
 * Dynamic (Track Time Saved nodes); the notices read the open workflow's nodes from `useWorkflowStore`.
 */

import type { WorkflowSettings } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface TimeSavedFieldsProps {
  /** the settings being edited (saved by the modal) */
  draft: WorkflowSettings;
  /** merges a patch into `draft` */
  set(patch: Partial<WorkflowSettings>): void;
}

/** stub (L12): renders nothing until L12 draws it */
export function TimeSavedFields(_props: TimeSavedFieldsProps): ReactNode {
  return null;
}
