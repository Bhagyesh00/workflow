/**
 * P6-79 (L8): on a protected workspace (`useProtectedWorkspace()`), says why the builder's Accept or the
 * Assistant's write tools are off; renders nothing otherwise. The server is the lock; this only explains it.
 */
import type { ReactNode } from 'react';
import { useProtectedWorkspace } from '../../lib/protected';
import { Callout } from '../ui/misc';

export interface ProtectedNoticeProps {
  area: 'builder' | 'assistant';
}

export const PROTECTED_NOTICE_TEXTS = {
  title: 'This workspace is protected',
  builder:
    'It is in read-only mode, so Accept and Run draft are off: the draft cannot be saved or run. Discard still works.',
  assistant:
    'It is in read-only mode, so the Assistant cannot create, change, move, archive or run workflows, create credentials, folders or tables, or change a table structure. Reading, publishing and table rows still work.',
} as const;

export function ProtectedNotice({ area }: ProtectedNoticeProps): ReactNode {
  const protectedWorkspace = useProtectedWorkspace();
  if (!protectedWorkspace) return null;
  return (
    <div role="status" data-testid={`protected-notice-${area}`} className="mb-2">
      <Callout tone="warn" title={PROTECTED_NOTICE_TEXTS.title}>
        {PROTECTED_NOTICE_TEXTS[area]}
      </Callout>
    </div>
  );
}
