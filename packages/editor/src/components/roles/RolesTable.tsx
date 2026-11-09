/** P6-46: the roles of one type: name, type (system or custom), users, actions. */
import type { CustomRole } from '../../api/types';
import type { RoleKind } from '../../pages/RolesPages';

export interface RolesTableProps {
  roleType: RoleKind;
  roles: CustomRole[];
}

export function RolesTable(_props: RolesTableProps) {
  // stub (L23)
  return null;
}
