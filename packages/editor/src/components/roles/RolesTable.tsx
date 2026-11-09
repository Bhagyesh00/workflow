/** P6-46: the roles of one type: name, type (system or custom), users, actions. */
import { useState } from 'react';
import { Link } from 'react-router';
import type { CustomRole } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import type { RoleKind } from '../../pages/RolesPages';
import { Badge } from '../ui/misc';
import { DeleteRoleDialog } from './DeleteRoleDialog';

/** `/settings/{project-roles|instance-roles}/{new|edit/:slug|view/:slug}` */
export function roleEditorPath(roleType: RoleKind, mode: 'new' | 'edit' | 'view', slug?: string): string {
  const base = roleType === 'project' ? '/settings/project-roles' : '/settings/instance-roles';
  return mode === 'new' ? `${base}/new` : `${base}/${mode}/${encodeURIComponent(slug ?? '')}`;
}

export interface RolesTableProps {
  roleType: RoleKind;
  roles: CustomRole[];
}

function usersText(role: CustomRole, roleType: RoleKind): string {
  const users = role.usedByUsers ?? 0;
  const text = `${users} ${users === 1 ? 'user' : 'users'}`;
  if (roleType !== 'project') return text;
  const projects = role.usedByProjects ?? 0;
  return `${text} in ${projects} ${projects === 1 ? 'project' : 'projects'}`;
}

export function RolesTable({ roleType, roles }: RolesTableProps) {
  const { can } = usePermissions();
  const [deleting, setDeleting] = useState<CustomRole | null>(null);
  const canWrite =
    roleType === 'global' ? can('role:manage') : can('role:manage') || can('role:manageProject');
  const rows = [...roles].sort((a, b) => Number(b.systemRole) - Number(a.systemRole));

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {roleType === 'project' ? 'Project roles' : 'Workspace roles'}
          </caption>
          <thead className="bg-surface-2 text-xs text-ink-2">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Type
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Used by
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((role) => (
              <tr key={role.slug} className="border-t border-line" data-role={role.slug}>
                <td className="px-3 py-2">
                  <Link
                    className="font-semibold text-ink hover:underline"
                    to={roleEditorPath(roleType, role.systemRole ? 'view' : 'edit', role.slug)}
                  >
                    {role.displayName}
                  </Link>
                  {role.description && <p className="text-xs text-ink-2">{role.description}</p>}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={role.systemRole ? 'neutral' : 'brand'}>
                    {role.systemRole ? 'System' : 'Custom'}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-ink-2">{usersText(role, roleType)}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-3">
                    {role.systemRole || !canWrite ? (
                      <Link
                        className="text-brand hover:underline"
                        aria-label={`View ${role.displayName}`}
                        to={roleEditorPath(roleType, 'view', role.slug)}
                      >
                        View
                      </Link>
                    ) : (
                      <>
                        <Link
                          className="text-brand hover:underline"
                          aria-label={`Edit ${role.displayName}`}
                          to={roleEditorPath(roleType, 'edit', role.slug)}
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          className="text-err hover:underline"
                          aria-label={`Delete ${role.displayName}`}
                          onClick={() => setDeleting(role)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}
