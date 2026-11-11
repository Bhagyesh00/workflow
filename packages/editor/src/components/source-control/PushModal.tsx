/**
 * P6-76 (L6): the push modal: the changed files by type with checkboxes and a filter, the commit message, Push;
 * "View diff" opens `RemoteDiffDialog`. It sends only (id, type) of the picked files; the server builds the paths.
 */
import type { ReactNode } from 'react';
import type { PushResult } from '../../api/types';

export interface PushModalProps {
  open: boolean;
  onClose(): void;
  onPushed(result: PushResult): void;
}

/** stub (L6): renders nothing until L6 draws it */
export function PushModal(_props: PushModalProps): ReactNode {
  return null;
}
