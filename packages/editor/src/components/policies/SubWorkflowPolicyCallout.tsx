/**
 * P6-50 (L5): NDV callout on an Execute Workflow node whose sub-workflow would not start under the
 * policies (`typePoliciesApi.subWorkflowPolicyCheck`).
 */

import type { WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface SubWorkflowPolicyCalloutProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

/** stub (L5): renders nothing until L5 draws it */
export function SubWorkflowPolicyCallout(_props: SubWorkflowPolicyCalloutProps): ReactNode {
  return null;
}
