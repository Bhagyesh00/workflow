/**
 * P6-41: the page header of Overview, Shared with you and a project: title (with the project's icon), and
 * the Create button (workflow, credential, folder, data table, variable) gated by the project's scopes.
 */
import type { ProjectPageKind } from '../../pages/ProjectPages';

export interface ProjectHeaderProps {
  kind: ProjectPageKind;
  /** set when `kind` is 'project' */
  projectId?: string;
}

export function ProjectHeader(_props: ProjectHeaderProps) {
  // stub (L18)
  return null;
}
