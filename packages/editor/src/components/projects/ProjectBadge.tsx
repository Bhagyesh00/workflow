/** P6-43: a row's home project, with the count of projects it is shared with. */
import { Share2 } from 'lucide-react';
import type { ProjectRef } from '../../api/types';
import { ProjectIconView } from './ProjectNav';

export interface ProjectBadgeProps {
  homeProject?: ProjectRef | null;
  sharedWithProjects?: ProjectRef[];
  resourceType: 'workflow' | 'credential' | 'folder' | 'dataTable';
}

const NOUNS: Record<ProjectBadgeProps['resourceType'], string> = {
  workflow: 'workflow',
  credential: 'credential',
  folder: 'folder',
  dataTable: 'data table',
};

export function ProjectBadge({ homeProject, sharedWithProjects, resourceType }: ProjectBadgeProps) {
  if (!homeProject) return null;
  const shared = sharedWithProjects ?? [];
  const home = homeProject.type === 'personal' ? 'Personal' : homeProject.name;
  const sharedTitle = shared.length
    ? `This ${NOUNS[resourceType]} is shared with ${shared
        .map((p) => (p.type === 'personal' ? 'a personal project' : p.name))
        .join(', ')}`
    : undefined;
  return (
    <span
      data-testid="project-badge"
      title={`Project: ${home}`}
      className="inline-flex max-w-44 min-w-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-medium text-ink-2"
    >
      <ProjectIconView icon={homeProject.icon} type={homeProject.type} size={11} />
      <span className="truncate">{home}</span>
      {shared.length > 0 && (
        <span
          role="img"
          title={sharedTitle}
          aria-label={`Shared with ${shared.length} ${shared.length === 1 ? 'project' : 'projects'}`}
          className="inline-flex shrink-0 items-center gap-0.5 border-l border-line pl-1 text-ink-3"
        >
          <Share2 size={10} aria-hidden="true" />+{shared.length}
        </span>
      )}
    </span>
  );
}
