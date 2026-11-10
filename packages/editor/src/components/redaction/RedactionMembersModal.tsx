/**
 * P6-53 (L8): who can reveal the project's runs (`GET /roles/:slug/assignments/:projectId/members`).
 */
import type { ReactNode } from 'react';

export interface RedactionMembersModalProps {
  open: boolean;
  onClose(): void;
  projectId: string;
}

/** stub (L8): renders nothing until L8 draws it */
export function RedactionMembersModal(_props: RedactionMembersModalProps): ReactNode {
  return null;
}
