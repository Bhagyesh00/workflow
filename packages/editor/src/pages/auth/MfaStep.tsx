/**
 * P6-18: the second sign-in step: a 6 digit code from the authenticator app, or a recovery code.
 * LoginPage keeps the email and password and sends them again with the code (POST /auth/login).
 */
import type { MfaLoginInput } from '../../api/types';

export interface MfaStepProps {
  /** the code is being checked */
  pending: boolean;
  /** the last attempt's error, shown above the field */
  error: string | null;
  onSubmit(input: MfaLoginInput): void;
  /** back to email and password */
  onCancel(): void;
}

export function MfaStep(_props: MfaStepProps) {
  // stub (L2)
  return null;
}
