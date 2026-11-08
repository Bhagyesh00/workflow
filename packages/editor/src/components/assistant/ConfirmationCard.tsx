/**
 * P5-67 (L2): a waiting card, by `inputType`: `ApprovalCard` (L3), `QuestionsCard` and `CredentialSetupCard` (L6),
 * `DomainApprovalCard` (L10).
 */
import type { AssistantConfirmation } from '@workflow/workflow';
import { ApprovalCard } from './ApprovalCard';
import { CredentialSetupCard } from './CredentialSetupCard';
import { DomainApprovalCard } from './DomainApprovalCard';
import { QuestionsCard } from './QuestionsCard';

export interface ConfirmationCardProps {
  confirmation: AssistantConfirmation;
}

function CardBody({ confirmation }: ConfirmationCardProps) {
  switch (confirmation.inputType) {
    case 'approval':
      return <ApprovalCard confirmation={confirmation} />;
    case 'questions':
      return <QuestionsCard confirmation={confirmation} />;
    case 'domain':
      return <DomainApprovalCard confirmation={confirmation} />;
    case 'credential':
      return <CredentialSetupCard confirmation={confirmation} />;
    default:
      return null;
  }
}

export function ConfirmationCard({ confirmation }: ConfirmationCardProps) {
  return (
    <div data-request-id={confirmation.requestId} data-input-type={confirmation.inputType}>
      <CardBody confirmation={confirmation} />
    </div>
  );
}
