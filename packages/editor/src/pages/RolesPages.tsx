/**
 * P6-46: `/settings/roles` (tabs: project roles, instance roles; `role:manage`) and the role editor at
 * `/settings/project-roles/{new,edit/:slug,view/:slug}` and `/settings/instance-roles/{...}`.
 */
export type RoleKind = 'project' | 'global';

export function RolesPage() {
  // stub (L23)
  return null;
}

export interface RoleEditorPageProps {
  roleType: RoleKind;
  mode: 'new' | 'edit' | 'view';
  /** set in 'edit' and 'view' (the route's `:slug`) */
  slug?: string;
}

export function RoleEditorPage(_props: RoleEditorPageProps) {
  // stub (L23)
  return null;
}
