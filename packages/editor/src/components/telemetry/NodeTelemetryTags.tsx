/**
 * P6-67 (L11): node settings slot: `node.customTelemetryTags.tag`, values are expressions over item 0,
 * `node.custom.<key>` on the node's span. Writes `onChange({ customTelemetryTags })`; read-only on a
 * protected workspace's canvas.
 */
import type { WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface NodeTelemetryTagsProps {
  node: WorkflowNode;
  onChange(patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>): void;
  readOnly: boolean;
}

// stub (L11)
export function NodeTelemetryTags(_props: NodeTelemetryTagsProps): ReactNode {
  return null;
}
