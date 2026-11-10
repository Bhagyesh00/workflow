/**
 * P6-50 (L5): NDV callout on an agent whose connected tool types a policy blocks.
 */

import type { WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface ToolRestrictedCalloutProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

/** stub (L5): renders nothing until L5 draws it */
export function ToolRestrictedCallout(_props: ToolRestrictedCalloutProps): ReactNode {
  return null;
}
