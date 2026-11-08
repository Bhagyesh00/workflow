/**
 * P5-68 (L3): a person's answer to a card (`POST /assistant/confirm/:requestId`). The card leaves the pending
 * list when the server's `confirmation-resolved` event arrives, so a second tab shows the same outcome.
 */
import type { AssistantConfirmAnswer } from '@workflow/workflow';

export async function answerConfirmation(_requestId: string, _answer: AssistantConfirmAnswer): Promise<void> {
  throw new Error('not implemented (L3)');
}
