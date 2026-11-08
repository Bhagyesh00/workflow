/**
 * P5-70 (L7): a draft the Assistant built. Loading it fills the store's `drafts`; Accept saves it as a workflow
 * through the server (a person only, editor role); Discard closes it. Nothing here runs the workflow.
 *
 * The store keeps the drafts of the open thread only: an answer for a thread that is no longer open is returned
 * to the caller but not stored.
 */
import { assistantApi } from '../../api/endpoints';
import type {
  AssistantAcceptDraftBody,
  AssistantAcceptDraftResult,
  AssistantDraftView,
} from '../../api/types';
import { useAssistantStore } from '../../stores/assistant-store';

/** stores `view` when `threadId` is still the open thread */
function remember(threadId: string, draftId: string, view: AssistantDraftView): void {
  const store = useAssistantStore.getState();
  if (store.activeThreadId === threadId) store.putDraft(draftId, view);
}

export async function loadDraft(threadId: string, draftId: string): Promise<AssistantDraftView> {
  const view = await assistantApi.draft(threadId, draftId);
  remember(threadId, draftId, view);
  return view;
}

export async function acceptDraft(
  threadId: string,
  draftId: string,
  body: AssistantAcceptDraftBody = {},
): Promise<AssistantAcceptDraftResult> {
  const result = await assistantApi.acceptDraft(threadId, draftId, body);
  const current = useAssistantStore.getState().drafts[draftId];
  // the saved draft has nothing left to assign; the diff stays what the person accepted
  if (current) remember(threadId, draftId, { ...current, draft: result.draft, assignments: [] });
  return result;
}

export async function discardDraft(threadId: string, draftId: string): Promise<void> {
  await assistantApi.discardDraft(threadId, draftId);
  const current = useAssistantStore.getState().drafts[draftId];
  if (current) {
    remember(threadId, draftId, {
      ...current,
      draft: { ...current.draft, status: 'discarded' },
      assignments: [],
    });
  }
}
