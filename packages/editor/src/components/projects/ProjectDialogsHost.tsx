/**
 * P6-44: renders the dialog `openProjectDialog` asked for (stores/project-dialog-store.ts): `ShareDialog`
 * or `MoveDialog`. Mounted once, in App.tsx.
 */
import { closeProjectDialog, useProjectDialogStore } from '../../stores/project-dialog-store';
import { MoveDialog } from './MoveDialog';
import { ShareDialog } from './ShareDialog';

export function ProjectDialogsHost() {
  const dialog = useProjectDialogStore((s) => s.dialog);
  if (!dialog) return null;
  const key = `${dialog.kind}:${dialog.resource}:${dialog.id}`;
  if (dialog.kind === 'move') {
    return <MoveDialog key={key} resource={dialog.resource} id={dialog.id} onClose={closeProjectDialog} />;
  }
  // only workflows and credentials are shared (n8n has no folder share)
  if (dialog.resource === 'folder') return null;
  return <ShareDialog key={key} resource={dialog.resource} id={dialog.id} onClose={closeProjectDialog} />;
}
