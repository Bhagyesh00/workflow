/** P6-46: where a role is used: projects and members (GET /roles/:slug/assignments, /members). */
import type { RoleKind } from '../../pages/RolesPages';

export interface RoleAssignmentsProps {
  slug: string;
  roleType: RoleKind;
}

export function RoleAssignments(_props: RoleAssignmentsProps) {
  // stub (L23)
  return null;
}
