/** P6-19: Members row action (`user:resetPassword`): copies a password reset link; never for an owner. */
import type { Member } from '../../api/types';

export interface CopyResetLinkActionProps {
  member: Member;
}

export function CopyResetLinkAction(_props: CopyResetLinkActionProps) {
  // stub (L3)
  return null;
}
