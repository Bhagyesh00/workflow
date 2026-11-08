/**
 * P5-62: nodes of the draft that need a credential and have none get the first credential of each
 * type the user can use (n8n's rule); runs in the browser only, and the diff shows it. Stub until L2.
 */
import type { NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import type { CredentialSummary } from '../../api/types';

export function assignDefaultCredentials(
  _nodes: WorkflowNode[],
  _credentials: CredentialSummary[],
  _descriptions: { get(type: string): NodeTypeDescription | undefined },
): WorkflowNode[] {
  throw new Error('not implemented (L2)');
}
