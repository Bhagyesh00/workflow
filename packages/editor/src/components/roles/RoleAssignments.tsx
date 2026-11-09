/** P6-46: where a role is used: projects and members (GET /roles/:slug/assignments, /members). */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { rolesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { RoleAssignment, RoleMember } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import type { RoleKind } from '../../pages/RolesPages';
import { ProjectIconView } from '../projects/ProjectNav';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

export interface RoleAssignmentsProps {
  slug: string;
  roleType: RoleKind;
}

function MemberList({ members, label }: { members: RoleMember[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line rounded-lg border border-line text-sm">
      {members.map((m) => (
        <li key={m.userId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
          <span className="font-semibold text-ink">{m.name || m.email}</span>
          {m.name && <span className="text-ink-2">{m.email}</span>}
        </li>
      ))}
    </ul>
  );
}

function ProjectMembers({ slug, projectId, name }: { slug: string; projectId: string; name: string }) {
  const members = useQuery({
    queryKey: [...queryKeys.roleAssignments(slug), projectId, 'members'],
    queryFn: () => rolesApi.projectMembers(slug, projectId),
  });
  if (members.isPending) return <PageLoader label="Loading members" />;
  if (members.isError) return <Callout tone="err">{errorMessage(members.error)}</Callout>;
  return <MemberList members={members.data.members} label={`Members in ${name}`} />;
}

function ProjectRow({ slug, row }: { slug: string; row: RoleAssignment }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-line" data-project={row.projectId}>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-2 font-semibold text-ink">
            <ProjectIconView icon={row.projectIcon} type="team" />
            {row.projectName}
          </span>
        </td>
        <td className="px-3 py-2 text-ink-2">{row.memberCount}</td>
        <td className="px-3 py-2 text-ink-2">{row.lastAssigned ? formatDateTime(row.lastAssigned) : '—'}</td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            className="text-brand hover:underline"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} members in ${row.projectName}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide members' : 'Show members'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-surface-2">
          <td colSpan={4} className="px-3 py-2">
            <ProjectMembers slug={slug} projectId={row.projectId} name={row.projectName} />
          </td>
        </tr>
      )}
    </>
  );
}

function ProjectAssignments({ slug }: { slug: string }) {
  const assignments = useQuery({
    queryKey: queryKeys.roleAssignments(slug),
    queryFn: () => rolesApi.assignments(slug),
  });
  if (assignments.isPending) return <PageLoader label="Loading assignments" />;
  if (assignments.isError) return <Callout tone="err">{errorMessage(assignments.error)}</Callout>;
  if (assignments.data.projects.length === 0) {
    return <EmptyState title="Not used yet" description="No project gives this role to anyone." />;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Projects that use this role</caption>
        <thead className="bg-surface-2 text-xs text-ink-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Project
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Members
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Last assigned
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {assignments.data.projects.map((row) => (
            <ProjectRow key={row.projectId} slug={slug} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GlobalAssignments({ slug }: { slug: string }) {
  const members = useQuery({ queryKey: queryKeys.roleMembers(slug), queryFn: () => rolesApi.members(slug) });
  if (members.isPending) return <PageLoader label="Loading members" />;
  if (members.isError) return <Callout tone="err">{errorMessage(members.error)}</Callout>;
  if (members.data.members.length === 0) {
    return <EmptyState title="Not used yet" description="No one in the workspace has this role." />;
  }
  return <MemberList members={members.data.members} label="Members with this role" />;
}

export function RoleAssignments({ slug, roleType }: RoleAssignmentsProps) {
  return roleType === 'project' ? <ProjectAssignments slug={slug} /> : <GlobalAssignments slug={slug} />;
}
