/**
 * "Test a tool": asks for the values the model would pass to a tool node (P5-76, filled by L4,
 * which also mounts it from NodeDetailsView). `args` holds the tool's `$fromAI` scan; the caller
 * opens no modal when the scan is empty.
 */
import type { DataObject, FromAiArgument } from '@workflow/workflow';
import type { ReactElement } from 'react';

export interface ToolTestModalProps {
  open: boolean;
  nodeName: string;
  /** the node that normally calls the tool, for the prompt text */
  parentName: string;
  args: FromAiArgument[];
  onExecute: (query: DataObject) => void;
  onCancel: () => void;
}

export function ToolTestModal(_props: ToolTestModalProps): ReactElement {
  throw new Error('not implemented (L4)');
}
