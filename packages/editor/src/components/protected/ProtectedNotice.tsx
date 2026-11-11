/**
 * P6-79 (L8): on a protected workspace (`useProtectedWorkspace()`), says why the builder's Accept or the
 * Assistant's write tools are off; renders nothing otherwise.
 */
import type { ReactNode } from 'react';

export interface ProtectedNoticeProps {
  area: 'builder' | 'assistant';
}

/** stub (L8): renders nothing until L8 draws it */
export function ProtectedNotice(_props: ProtectedNoticeProps): ReactNode {
  return null;
}
