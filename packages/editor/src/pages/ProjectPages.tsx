/**
 * P6-41: the project pages. Overview (`/home/*`: every project the user can see), Shared with you
 * (`/shared/*`), and one project (`/projects/:id/*`, a personal project too) with its header, tabs and the
 * existing list pages inside. The routes are in App.tsx (C0-final for S1).
 *
 * The layout sets the current project (`useProjectStore`) from the route, so lists and creates read it; the
 * list tabs render the existing pages (L20 filters them by project).
 */
import { lazy, Suspense, useEffect } from 'react';
import { Outlet } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { useProject } from '../api/queries';
import { ProjectHeader } from '../components/projects/ProjectHeader';
import { ProjectTabs } from '../components/projects/ProjectTabs';
import { EmptyState, PageLoader } from '../components/ui/misc';
import { useProjectStore } from '../stores/project-store';
import { ExecutionsPage } from './ExecutionsPage';
import { WorkflowsPage } from './WorkflowsPage';

const CredentialsPage = lazy(() => import('./CredentialsPage').then((m) => ({ default: m.CredentialsPage })));
const DataTablesPage = lazy(() => import('./DataTablesPage').then((m) => ({ default: m.DataTablesPage })));

/** which page family: Overview (`/home`), Shared with you (`/shared`) or one project (`/projects/:id`) */
export type ProjectPageKind = 'home' | 'shared' | 'project';

/** the list tabs; a project also has Variables and Settings (their own components) */
export type ProjectResource = 'workflows' | 'credentials' | 'executions' | 'data-tables' | 'folders';

export interface ProjectLayoutProps {
  kind: ProjectPageKind;
  /** set when `kind` is 'project' (the route's `:id`) */
  projectId?: string;
}

/** header, tabs and the tab's page (`<Outlet />`); a project the user cannot open shows why instead */
export function ProjectLayout({ kind, projectId }: ProjectLayoutProps) {
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const current = kind === 'project' ? (projectId ?? null) : null;
  useEffect(() => {
    setCurrentProject(current);
    return () => setCurrentProject(null);
  }, [current, setCurrentProject]);
  const project = useProject(kind === 'project' ? projectId : null);
  if (kind === 'project' && project.isLoading) return <PageLoader label="Loading the project" />;
  if (kind === 'project' && project.error) {
    const missing = isApiError(project.error, 404);
    return (
      <EmptyState
        className="h-full"
        title={missing ? 'Project not found' : 'You cannot open this project'}
        description={
          missing ? 'It may have been deleted, or it is in another workspace.' : errorMessage(project.error)
        }
      />
    );
  }
  return (
    <>
      <ProjectHeader kind={kind} projectId={projectId} />
      <ProjectTabs kind={kind} projectId={projectId} />
      <Outlet />
    </>
  );
}

export interface ProjectResourcePageProps {
  kind: ProjectPageKind;
  resource: ProjectResource;
  /** set when `kind` is 'project' */
  projectId?: string;
}

/** one list tab: the existing page of that list */
export function ProjectResourcePage({ resource }: ProjectResourcePageProps) {
  switch (resource) {
    case 'workflows':
    case 'folders':
      return <WorkflowsPage />;
    case 'executions':
      return <ExecutionsPage />;
    case 'credentials':
      return (
        <Suspense fallback={<PageLoader />}>
          <CredentialsPage />
        </Suspense>
      );
    case 'data-tables':
      return (
        <Suspense fallback={<PageLoader />}>
          <DataTablesPage />
        </Suspense>
      );
  }
}
