/** P6-46: start a role from a preset (Admin, Editor, Viewer). */
import type { Scope } from '../../api/types';
import type { RoleKind } from '../../pages/RolesPages';

export interface RolePresetsProps {
  roleType: RoleKind;
  onPick(scopes: Scope[]): void;
  disabled?: boolean;
}

export function RolePresets(_props: RolePresetsProps) {
  // stub (L23)
  return null;
}
