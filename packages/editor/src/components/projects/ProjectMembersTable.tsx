/**
 * P6-42: the members of a project: search, role dropdown (system and custom project roles), remove. The
 * implicit members (owners and admins through their workspace role) show read only.
 */
import type { CustomRole, ProjectDetail } from '../../api/types';

export interface ProjectMembersTableProps {
  project: ProjectDetail;
  /** the project roles a member can get (GET /roles `project`) */
  roles: CustomRole[];
  /** the caller holds `project:manageMembers` here */
  editable: boolean;
  onChangeRole(userId: string, role: string): void;
  onRemove(userId: string): void;
}

export function ProjectMembersTable(_props: ProjectMembersTableProps) {
  // stub (L19)
  return null;
}
