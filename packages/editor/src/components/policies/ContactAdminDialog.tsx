/**
 * P6-50 (L5): "Contact admin": lists the workspace admins (from `/members`) to ask about a blocked type.
 */
import type { ReactNode } from 'react';

export interface ContactAdminDialogProps {
  open: boolean;
  onClose(): void;
  /** the blocked node or credential type */
  type: string;
  displayName?: string;
}

/** stub (L5): renders nothing until L5 draws it */
export function ContactAdminDialog(_props: ContactAdminDialogProps): ReactNode {
  return null;
}
