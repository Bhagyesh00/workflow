/**
 * Execution commands shared by the execution detail page and the command bar (P3-01): retry,
 * stop, delete and debug in the editor, with the page's toasts. Pass `deps` to refresh lists and
 * move to the next page.
 */
import type { QueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { executionsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import { confirmDialog } from '../../components/ui/Dialog';
import { toast } from '../../stores/ui-store';

export interface ExecutionCommandDeps {
  navigate?: (to: string) => void;
  queryClient?: QueryClient;
}

/** Retry a failed or stopped run; resolves with the new execution id (null on failure) and opens it. */
export async function retryExecution(
  id: string,
  useCurrent: boolean,
  deps: ExecutionCommandDeps = {},
): Promise<string | null> {
  try {
    const { executionId } = await executionsApi.retry(id, useCurrent);
    await deps.queryClient?.invalidateQueries({ queryKey: ['executions'] });
    toast.success('Retry started');
    deps.navigate?.(`/executions/${encodeURIComponent(executionId)}`);
    return executionId;
  } catch (error) {
    toast.error('Could not retry the execution', errorMessage(error));
    return null;
  }
}

export async function stopExecution(id: string, deps: ExecutionCommandDeps = {}): Promise<boolean> {
  try {
    await executionsApi.stop(id);
    await deps.queryClient?.invalidateQueries({ queryKey: queryKeys.execution(id) });
    toast.success('Execution stopped');
    return true;
  } catch (error) {
    toast.error('Could not stop the execution', errorMessage(error));
    return false;
  }
}

/** Asks first; resolves true when the execution was deleted (then goes to the list). */
export async function deleteExecution(id: string, deps: ExecutionCommandDeps = {}): Promise<boolean> {
  const ok = await confirmDialog({
    title: 'Delete this execution?',
    description: 'Its data is removed for good.',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!ok) return false;
  try {
    await executionsApi.remove(id);
    await deps.queryClient?.invalidateQueries({ queryKey: ['executions'] });
    toast.success('Execution deleted');
    deps.navigate?.('/executions');
    return true;
  } catch (error) {
    toast.error('Could not delete the execution', errorMessage(error));
    return false;
  }
}

/** the editor URL that replays a past run with its trigger data pinned ("Debug in editor") */
export function debugExecutionPath(workflowId: string, id: string): string {
  return `/workflow/${encodeURIComponent(workflowId)}?debug=${encodeURIComponent(id)}`;
}

/** Open the workflow with this run's trigger data pinned. */
export function debugExecution(
  workflowId: string,
  id: string,
  deps: Required<Pick<ExecutionCommandDeps, 'navigate'>>,
): void {
  deps.navigate(debugExecutionPath(workflowId, id));
}
