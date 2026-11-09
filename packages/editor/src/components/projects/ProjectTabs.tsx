/**
 * P6-41: the tabs under the header, n8n's order: Workflows, Credentials, Executions, Data tables; a project
 * adds Variables and Settings. Links under `/home/*`, `/shared/*` or `/projects/:id/*`.
 */
import { NavLink } from 'react-router';
import { useProject } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import type { ProjectPageKind } from '../../pages/ProjectPages';
import { cx } from '../ui/cx';

export interface ProjectTabsProps {
  kind: ProjectPageKind;
  /** set when `kind` is 'project' */
  projectId?: string;
}

/** the URL prefix of a page family */
export function projectBase(kind: ProjectPageKind, projectId?: string): string {
  if (kind === 'home') return '/home';
  if (kind === 'shared') return '/shared';
  return `/projects/${encodeURIComponent(projectId ?? '')}`;
}

export function ProjectTabs({ kind, projectId }: ProjectTabsProps) {
  const project = useProject(kind === 'project' ? projectId : null);
  const { can } = usePermissions();
  const base = projectBase(kind, projectId);
  const tabs: Array<{ to: string; label: string }> = [
    { to: `${base}/workflows`, label: 'Workflows' },
    { to: `${base}/credentials`, label: 'Credentials' },
  ];
  if (kind !== 'shared') {
    tabs.push(
      { to: `${base}/executions`, label: 'Executions' },
      { to: `${base}/data-tables`, label: 'Data tables' },
    );
  }
  if (kind === 'project') {
    if (can('projectVariable:list', project.data)) tabs.push({ to: `${base}/variables`, label: 'Variables' });
    if (project.data?.type === 'team' && can('project:update', project.data))
      tabs.push({ to: `${base}/settings`, label: 'Settings' });
  }
  return (
    <nav aria-label="Project sections" className="mx-auto max-w-6xl px-6">
      <ul className="flex flex-wrap items-end gap-5 border-b border-line">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              className={({ isActive }) =>
                cx(
                  '-mb-px inline-flex border-b-2 pb-2 text-sm font-semibold transition-colors',
                  isActive ? 'border-brand text-ink' : 'border-transparent text-ink-2 hover:text-ink',
                )
              }
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
