/**
 * P5-70 (L7): a draft the Assistant built. Loading it fills the store's `drafts`; Accept saves it as a workflow
 * through the server (a person only, editor role); Discard closes it. Nothing here runs the workflow.
 *
 * Accept names the draft version the card shows (`draft.updatedAt`), so the server saves only that version. A
 * refused Accept (409: the draft was rebuilt, is no longer open, or its workflow changed) loads the draft again,
 * so the card shows what is stored now next to the server's reason.
 *
 * The store keeps the drafts of the open thread only: an answer for a thread that is no longer open is returned
 * to the caller but not stored.
 */
import { isApiError } from '../../api/client';
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

/** saves the draft at `updatedAt`, the version the person saw; any other version is refused (409) */
export async function acceptDraft(
  threadId: string,
  draftId: string,
  updatedAt: string,
  body: Omit<AssistantAcceptDraftBody, 'updatedAt'> = {},
): Promise<AssistantAcceptDraftResult> {
  const sent: AssistantAcceptDraftBody & { updatedAt: string } = { ...body, updatedAt };
  let result: AssistantAcceptDraftResult;
  try {
    result = await assistantApi.acceptDraft(threadId, draftId, sent);
  } catch (error) {
    // refused: show the draft as it is stored now, so the next Accept is for what the person sees
    if (isApiError(error, 409)) await loadDraft(threadId, draftId).catch(() => undefined);
    throw error;
  }
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
