/**
 * P6-43: the project filter of the Overview lists (null = every project), and the one hook the list pages
 * and creates share: which project the page works in (the route's, else none), the list filter it sends, the
 * project new rows go to, and whether the caller may create there.
 */
import { useQuery } from '@tanstack/react-query';
import type { Scope } from '@workflow/workflow';
import { useCallback, useMemo, useState } from 'react';
import { matchPath, useLocation } from 'react-router';
import { projectsApi } from '../../api/endpoints';
import { queryKeys, useMe, useProject, useProjects } from '../../api/queries';
import type { ProjectListFilter } from '../../api/types';
import { canWith } from '../../lib/permissions';
import { useProjectStore } from '../../stores/project-store';
import { Select } from '../ui/Field';

export interface ProjectFilterProps {
  value: string | null;
  onChange(projectId: string | null): void;
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps) {
  const projects = useProjects();
  const rows = projects.data ?? [];
  const known = value === null || rows.some((p) => p.id === value);
  return (
    <Select
      aria-label="Filter by project"
      className="w-44"
      value={known ? (value ?? '') : ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">All projects</option>
      {rows.map((p) => (
        <option key={p.id} value={p.id}>
          {p.type === 'personal' ? 'Personal' : p.name}
        </option>
      ))}
    </Select>
  );
}

export type ListScopeKind = 'home' | 'shared' | 'project';

export interface ProjectListScope {
  kind: ListScopeKind;
  /** the project the route names (null on Overview and Shared with you) */
  projectId: string | null;
  /** the list route of the page, so folder and back links stay inside the project */
  base: string;
  /** the filter the lists send: the route's project, or Overview's picked one, and `includeScopes` */
  listFilter: ProjectListFilter;
  /** the Overview filter (home only) */
  filterValue: string | null;
  setFilterValue(projectId: string | null): void;
  /** the project new rows go to (the route's project, else the caller's personal project; none on Shared) */
  createProjectId: string | undefined;
  /** the caller may create in that project (the workspace role, or the project's role) */
  canCreate(scope: Scope): boolean;
}

/** which list route a page is shown on: `/home/*`, `/shared/*` or `/projects/:id/*`; `resource` names the tab */
export function useProjectListScope(resource: 'workflows' | 'credentials' | 'executions' | 'data-tables') {
  const { pathname } = useLocation();
  const stored = useProjectStore((s) => s.currentProjectId);
  const me = useMe().data;
  const [picked, setPicked] = useState<string | null>(null);
  const fromRoute = matchPath('/projects/:id/*', pathname)?.params.id;
  const kind: ListScopeKind = fromRoute ? 'project' : pathname.startsWith('/shared') ? 'shared' : 'home';
  const projectId = kind === 'project' ? decodeURIComponent(fromRoute ?? '') || (stored ?? null) : null;
  const project = useProject(projectId);
  const personal = useQuery({
    queryKey: queryKeys.personalProject,
    queryFn: projectsApi.personal,
    enabled: kind === 'home',
    staleTime: 60_000,
  });
  const target = kind === 'project' ? project.data : kind === 'home' ? personal.data : undefined;
  const filterProject = kind === 'home' ? picked : projectId;
  const base =
    kind === 'project'
      ? `/projects/${encodeURIComponent(projectId ?? '')}/${resource}`
      : `/${kind}/${resource}`;
  const listFilter = useMemo<ProjectListFilter>(
    () => ({
      includeScopes: true,
      ...(filterProject ? { projectId: filterProject } : {}),
      ...(kind === 'shared' ? { onlySharedWithMe: true } : {}),
    }),
    [filterProject, kind],
  );
  const canCreate = useCallback(
    (scope: Scope) => kind !== 'shared' && canWith(me, scope, target),
    [kind, me, target],
  );
  return {
    kind,
    projectId,
    base,
    listFilter,
    filterValue: picked,
    setFilterValue: setPicked,
    createProjectId: target?.id ?? (kind === 'project' ? (projectId ?? undefined) : undefined),
    canCreate,
  } satisfies ProjectListScope;
}
