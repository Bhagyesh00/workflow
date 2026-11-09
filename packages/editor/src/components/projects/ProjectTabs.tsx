/**
 * P6-41: the tabs under the header, n8n's order: Workflows, Credentials, Executions, Data tables; a project
 * adds Variables and Settings. Links under `/home/*`, `/shared/*` or `/projects/:id/*`.
 */
import type { ProjectPageKind } from '../../pages/ProjectPages';

export interface ProjectTabsProps {
  kind: ProjectPageKind;
  /** set when `kind` is 'project' */
  projectId?: string;
}

export function ProjectTabs(_props: ProjectTabsProps) {
  // stub (L18)
  return null;
}
