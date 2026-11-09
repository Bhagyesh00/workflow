/** P6-46: delete a custom role; a role in use is refused, a global one may be reassigned first. */
import type { CustomRole } from '../../api/types';

export interface DeleteRoleDialogProps {
  role: CustomRole;
  onClose(): void;
  onDeleted?(): void;
}

export function DeleteRoleDialog(_props: DeleteRoleDialogProps) {
  // stub (L23)
  return null;
}
