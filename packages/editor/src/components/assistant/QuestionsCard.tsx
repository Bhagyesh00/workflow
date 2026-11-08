/**
 * P5-69 (L6): `ask_user`'s questions (single, multi, text), answered or dismissed.
 */
import type { AssistantConfirmationOf } from '../../api/types';

export interface QuestionsCardProps {
  confirmation: AssistantConfirmationOf<'questions'>;
}

export function QuestionsCard(_props: QuestionsCardProps) {
  // L6 renders it
  return null;
}
