/**
 * Open sub-workflows and credentials from the editor (P3-12, as n8n useWorkflowCommands):
 * - a sub-workflow per Execute Workflow node whose workflowId has a value (name, else id), opened
 *   in a new tab (noreferrer); also Ctrl/Cmd+Shift+O and the node context menu;
 * - a credential per distinct credential the nodes use, opened in the editor's credential modal
 *   (ui.openCredentialId, rendered by OpenCredentialHost).
 *
 * C0 STUB: lane L3 writes the bodies.
 */
import type { WorkflowNode } from '@workflow/workflow';

export interface SubWorkflowTarget {
  nodeName: string;
  workflowId: string;
  /** the selected workflow's name when known, else its id */
  label: string;
}

export interface CredentialTarget {
  id: string;
  name: string;
  /** credential type name */
  type: string;
}

export function subWorkflowTargets(_nodes: readonly WorkflowNode[]): SubWorkflowTarget[] {
  return [];
}

export function credentialTargets(_nodes: readonly WorkflowNode[]): CredentialTarget[] {
  return [];
}

/** Open the workflow the named Execute Workflow node calls (no-op for other nodes). */
export function openSubWorkflow(_nodeName: string): void {
  throw new Error('not implemented (L3)');
}

export function openCredential(_credentialId: string): void {
  throw new Error('not implemented (L3)');
}
