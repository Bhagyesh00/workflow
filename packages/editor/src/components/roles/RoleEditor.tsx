/**
 * P6-46: name, description and the scope checkboxes by resource (allow lists of custom-role-scopes.ts), with
 * the escalation warnings; the instance editor shows the static personal space block.
 */
import type { Scope } from '../../api/types';
import type { RoleKind } from '../../pages/RolesPages';

export interface RoleDraft {
  displayName: string;
  description: string;
  scopes: Scope[];
}

export interface RoleEditorProps {
  roleType: RoleKind;
  value: RoleDraft;
  onChange(next: RoleDraft): void;
  readOnly?: boolean;
}

export function RoleEditor(_props: RoleEditorProps) {
  // stub (L23)
  return null;
}
