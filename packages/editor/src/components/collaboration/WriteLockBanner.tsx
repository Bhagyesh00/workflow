/**
 * P6-81 (L14): the read-only banner while another user or tab holds the write lock.
 */
import type { ReactNode } from 'react';

export interface WriteLockBannerProps {
  workflowId: string;
}

/** stub (L14): renders nothing until L14 draws it */
export function WriteLockBanner(_props: WriteLockBannerProps): ReactNode {
  return null;
}
