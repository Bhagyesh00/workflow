/**
 * P6-44: move a workflow, credential or folder to another project, with the preview (restricted and
 * unpublish lists), credential picks and "Moving will remove any existing sharing".
 */
export interface MoveDialogProps {
  resource: 'workflow' | 'credential' | 'folder';
  id: string;
  onClose(): void;
}

export function MoveDialog(_props: MoveDialogProps) {
  // stub (L21)
  return null;
}
