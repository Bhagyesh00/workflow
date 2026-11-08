/**
 * P5-68 (L3): approve or deny one write: title with the resource name, plain facts, previews with omitted counts,
 * Always allow this session (only when `allowSession`), countdown; values as text.
 */
import type { AssistantConfirmationOf } from '../../api/types';

export interface ApprovalCardProps {
  confirmation: AssistantConfirmationOf<'approval'>;
}

export function ApprovalCard(_props: ApprovalCardProps) {
  // L3 renders it
  return null;
}
