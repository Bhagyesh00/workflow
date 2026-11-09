/**
 * P6-41: the project pages. Overview (`/home/*`: every project the user can see), Shared with you
 * (`/shared/*`), and one project (`/projects/:id/*`, a personal project too) with its header, tabs and the
 * existing list pages inside. The routes are in App.tsx (C0-final for S1).
 *
 * stub (L18): C0 renders the existing list pages, so the routes work; the header and tabs render nothing yet.
 */
import { lazy, Suspense } from 'react';
import { Outlet } from 'react-router';
import { ProjectHeader } from '../components/projects/ProjectHeader';
import { ProjectTabs } from '../components/projects/ProjectTabs';
import { PageLoader } from '../components/ui/misc';
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

/** header, tabs and the tab's page (`<Outlet />`) */
export function ProjectLayout({ kind, projectId }: ProjectLayoutProps) {
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

/** one list tab; C0 shows the existing page of that list */
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
