/**
 * P5-73 (L10): a fetch to a new host: full URL and host as text, allow once, allow the domain, allow all, deny.
 */
import type { AssistantConfirmationOf } from '../../api/types';

export interface DomainApprovalCardProps {
  confirmation: AssistantConfirmationOf<'domain'>;
}

export function DomainApprovalCard(_props: DomainApprovalCardProps) {
  // L10 renders it
  return null;
}
