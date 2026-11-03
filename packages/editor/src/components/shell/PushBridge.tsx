/** Keeps one SSE connection open while signed in and routes events to the stores. */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectPush } from '../../api/push';
import type { PushEvent } from '../../api/types';
import { useRunStore } from '../../stores/run-store';
import { useWorkflowStore } from '../../stores/workflow-store';

export function handlePushEvent(event: PushEvent): void {
  const openWorkflowId = useWorkflowStore.getState().meta.id ?? null;
  useRunStore.getState().receive(event, openWorkflowId);
}

export function PushBridge({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    void tenantId; // reconnect when the workspace changes: the server binds the stream to the session's tenant
    const connection = connectPush((event) => {
      handlePushEvent(event);
      if (event.type === 'executionFinished' || event.type === 'executionStarted') {
        void queryClient.invalidateQueries({ queryKey: ['executions'] });
      }
      if (event.type === 'workflowReviewChanged') {
        void queryClient.invalidateQueries({ queryKey: ['workflow-reviews'] });
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      }
    });
    return () => connection.close();
  }, [queryClient, tenantId]);
  return null;
}
