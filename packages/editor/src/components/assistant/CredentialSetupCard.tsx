/**
 * P5-69 (L6): `setup_credentials`: opens the existing credential dialog for the type; the model never sees data.
 */
import type { AssistantConfirmationOf } from '../../api/types';

export interface CredentialSetupCardProps {
  confirmation: AssistantConfirmationOf<'credential'>;
}

export function CredentialSetupCard(_props: CredentialSetupCardProps) {
  // L6 renders it
  return null;
}
