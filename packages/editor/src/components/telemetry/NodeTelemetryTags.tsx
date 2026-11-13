/**
 * P6-67 (L11): node settings slot: `node.customTelemetryTags.tag`, values are expressions over item 0,
 * `node.custom.<key>` on the node's span. Writes `onChange({ customTelemetryTags })`; read-only on a
 * protected workspace's canvas.
 */
import { telemetryTagsOf, type WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';
import { TelemetryTagsField } from './TelemetryTagsField';

export interface NodeTelemetryTagsProps {
  node: WorkflowNode;
  onChange(patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>): void;
  readOnly: boolean;
  /** true while a row is invalid: the node view holds back Execute step */
  onValidityChange?(invalid: boolean): void;
}

export function NodeTelemetryTags({
  node,
  onChange,
  readOnly,
  onValidityChange,
}: NodeTelemetryTagsProps): ReactNode {
  return (
    <TelemetryTagsField
      value={telemetryTagsOf(node.customTelemetryTags)}
      disabled={readOnly}
      onValidityChange={onValidityChange}
      onChange={(next) => onChange({ customTelemetryTags: next.length > 0 ? { tag: next } : undefined })}
      valuePlaceholder="Value or ={{ expression }}"
      hint="Added to this node's span as node.custom.<key>. A value starting with = is an expression over the first item."
    />
  );
}
