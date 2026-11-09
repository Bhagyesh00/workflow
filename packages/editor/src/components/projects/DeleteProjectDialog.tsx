/**
 * P6-42: delete a team project: radio Transfer (to another project) or Wipe; wipe needs the text
 * "delete all data".
 */
import type { ProjectDetail } from '../../api/types';

export interface DeleteProjectDialogProps {
  project: ProjectDetail;
  onClose(): void;
  onDeleted?(): void;
}

export function DeleteProjectDialog(_props: DeleteProjectDialogProps) {
  // stub (L19)
  return null;
}
