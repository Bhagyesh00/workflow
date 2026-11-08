/**
 * P5-67 (L2): a waiting card, by `inputType`: `ApprovalCard` (L3), `QuestionsCard` and `CredentialSetupCard` (L6),
 * `DomainApprovalCard` (L10).
 */
import type { AssistantConfirmation } from '@workflow/workflow';

export interface ConfirmationCardProps {
  confirmation: AssistantConfirmation;
}

export function ConfirmationCard(_props: ConfirmationCardProps) {
  // L2 renders it
  return null;
}
