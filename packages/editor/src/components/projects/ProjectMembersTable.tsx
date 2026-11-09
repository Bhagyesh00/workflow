/**
 * P6-42: the members of a project: search, role dropdown (system and custom project roles), remove. The
 * implicit members (owners and admins through their workspace role) show read only.
 */
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CustomRole, ProjectDetail } from '../../api/types';
import { IconButton } from '../ui/Button';
import { Select, TextInput } from '../ui/Field';
import { Badge } from '../ui/misc';

export interface ProjectMembersTableProps {
  project: ProjectDetail;
  /** the project roles a member can get (GET /roles `project`) */
  roles: CustomRole[];
  /** the caller holds `project:manageMembers` here */
  editable: boolean;
  onChangeRole(userId: string, role: string): void;
  onRemove(userId: string): void;
}

export function ProjectMembersTable({
  project,
  roles,
  editable,
  onChangeRole,
  onRemove,
}: ProjectMembersTableProps) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const match = (m: { name: string; email: string }) =>
    !needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle);
  const relations = project.relations.filter(match);
  const implicit = project.implicitMembers.filter(match);
  const roleName = (slug: string) => roles.find((r) => r.slug === slug)?.displayName ?? slug;
  const assignable = roles.filter((r) => r.slug !== 'project:personalOwner');

  return (
    <div className="flex flex-col gap-3">
      <TextInput
        type="search"
        aria-label="Search members"
        placeholder="Search by name or email"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-ink-2">
            <th className="py-1.5 pr-3 font-semibold">User</th>
            <th className="py-1.5 pr-3 font-semibold">Role</th>
            <th className="py-1.5 font-semibold">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {relations.map((m) => {
            const locked = m.role === 'project:personalOwner';
            return (
              <tr key={m.id} className="border-t border-line">
                <td className="py-2 pr-3">
                  <div className="font-semibold text-ink">{m.name || m.email}</div>
                  <div className="text-xs text-ink-2">{m.email}</div>
                </td>
                <td className="py-2 pr-3">
                  {editable && !locked ? (
                    <Select
                      aria-label={`Role of ${m.email}`}
                      value={m.role}
                      onChange={(e) => onChangeRole(m.id, e.target.value)}
                    >
                      {!assignable.some((r) => r.slug === m.role) && <option value={m.role}>{m.role}</option>}
                      {assignable.map((r) => (
                        <option key={r.slug} value={r.slug}>
                          {r.displayName}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span>{roleName(m.role)}</span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {editable && !locked && (
                    <IconButton label={`Remove ${m.email}`} onClick={() => onRemove(m.id)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
          {implicit.map((m) => (
            <tr key={`implicit-${m.id}`} className="border-t border-line">
              <td className="py-2 pr-3">
                <div className="font-semibold text-ink">{m.name || m.email}</div>
                <div className="text-xs text-ink-2">{m.email}</div>
              </td>
              <td className="py-2 pr-3">
                <Badge>{m.globalRole.displayName}</Badge>
              </td>
              <td className="py-2 text-right text-xs text-ink-2">Through the workspace role</td>
            </tr>
          ))}
          {relations.length === 0 && implicit.length === 0 && (
            <tr>
              <td colSpan={3} className="py-4 text-center text-ink-2">
                {needle ? 'No member matches your search.' : 'No members yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
