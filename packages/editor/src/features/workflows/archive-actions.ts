/**
 * Archive, unarchive and delete workflows (P3-07, n8n rules): archive unpublishes first;
 * unarchive does not republish; the editor deletes only archived workflows (confirm first).
 * Used by the editor header, the workflows list and the command bar.
 *
 * C0 STUB: lane L8 writes the bodies.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { WorkflowDTO } from '../../api/types';

export interface WorkflowActionDeps {
  navigate?: (to: string) => void;
  queryClient?: QueryClient;
}

/** Resolves with the archived workflow, or null when it failed (toast shown). */
export function archiveWorkflow(_id: string, _deps?: WorkflowActionDeps): Promise<WorkflowDTO | null> {
  throw new Error('not implemented (L8)');
}

export function unarchiveWorkflow(_id: string, _deps?: WorkflowActionDeps): Promise<WorkflowDTO | null> {
  throw new Error('not implemented (L8)');
}

/** Asks first; resolves true when the archived workflow was deleted. */
export function deleteArchivedWorkflow(_id: string, _deps?: WorkflowActionDeps): Promise<boolean> {
  throw new Error('not implemented (L8)');
}
