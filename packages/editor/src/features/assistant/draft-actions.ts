/**
 * P5-70 (L7): a draft the Assistant built. Loading it fills the store's `drafts`; Accept saves it as a workflow
 * through the server (a person only, editor role); Discard closes it. Nothing here runs the workflow.
 */
import type {
  AssistantAcceptDraftBody,
  AssistantAcceptDraftResult,
  AssistantDraftView,
} from '../../api/types';

export async function loadDraft(_threadId: string, _draftId: string): Promise<AssistantDraftView> {
  throw new Error('not implemented (L7)');
}

export async function acceptDraft(
  _threadId: string,
  _draftId: string,
  _body?: AssistantAcceptDraftBody,
): Promise<AssistantAcceptDraftResult> {
  throw new Error('not implemented (L7)');
}

export async function discardDraft(_threadId: string, _draftId: string): Promise<void> {
  throw new Error('not implemented (L7)');
}
