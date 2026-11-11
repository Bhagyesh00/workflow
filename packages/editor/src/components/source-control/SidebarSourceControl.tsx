/**
 * P6-76 (L6): the sidebar's branch name with Pull and Push (n8n's disable rules: Push is off on a protected
 * workspace); hidden while the workspace has no Git connection.
 */
import type { ReactNode } from 'react';

export interface SidebarSourceControlProps {
  /** the sidebar is collapsed to icons */
  collapsed: boolean;
}

/** stub (L6): renders nothing until L6 draws it */
export function SidebarSourceControl(_props: SidebarSourceControlProps): ReactNode {
  return null;
}
