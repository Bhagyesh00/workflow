/** P6-43: a row's home project, with the count of projects it is shared with. */
import type { ProjectRef } from '../../api/types';

export interface ProjectBadgeProps {
  homeProject?: ProjectRef | null;
  sharedWithProjects?: ProjectRef[];
  resourceType: 'workflow' | 'credential' | 'folder' | 'dataTable';
}

export function ProjectBadge(_props: ProjectBadgeProps) {
  // stub (L20)
  return null;
}
