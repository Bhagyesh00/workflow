/** P6-13: Members row switch (`user:update`): this member may sign in with a password while SSO is on. */
import type { Member } from '../../api/types';

export interface AllowManualLoginToggleProps {
  member: Member;
}

export function AllowManualLoginToggle(_props: AllowManualLoginToggleProps) {
  // stub (L11)
  return null;
}
