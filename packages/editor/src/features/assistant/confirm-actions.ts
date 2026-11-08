/**
 * P5-68 (L3): a person's answer to a card (`POST /assistant/confirm/:requestId`). The card leaves the pending
 * list when the server's `confirmation-resolved` event arrives, so a second tab shows the same outcome. A 404
 * means the card is no longer open (answered elsewhere, timed out, or the thread was stopped): it leaves this
 * tab's list at once and the error goes back to the card, which says so.
 */
import type { AssistantConfirmAnswer } from '@workflow/workflow';
import { ApiError } from '../../api/client';
import { assistantApi } from '../../api/endpoints';
import { useAssistantStore } from '../../stores/assistant-store';

export async function answerConfirmation(requestId: string, answer: AssistantConfirmAnswer): Promise<void> {
  try {
    await assistantApi.confirm(requestId, answer);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const { pending, setPending } = useAssistantStore.getState();
      setPending(pending.filter((card) => card.requestId !== requestId));
    }
    throw error;
  }
}
