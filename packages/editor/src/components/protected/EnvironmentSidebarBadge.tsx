/**
 * P6-80 (L9): the sidebar's lock and branch colour on a protected workspace (n8n's MainSidebarHeader lock);
 * renders nothing on a writable one. The branch name and colour come from the source control preferences once
 * the workspace is connected; without a connection the lock stands alone.
 */
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSourceControlPreferences } from '../../api/queries';
import { useProtectedWorkspace } from '../../lib/protected';
import { cx } from '../ui/cx';

export interface EnvironmentSidebarBadgeProps {
  /** the sidebar is collapsed to icons */
  collapsed: boolean;
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function EnvironmentSidebarBadge({ collapsed }: EnvironmentSidebarBadgeProps): ReactNode {
  const isProtected = useProtectedWorkspace();
  const preferences = useSourceControlPreferences(isProtected).data;
  if (!isProtected) return null;
  const branch = preferences?.connected ? preferences.branchName : '';
  const color =
    preferences?.connected && HEX_COLOR.test(preferences.branchColor) ? preferences.branchColor : '';
  const label = branch ? `Protected workspace, branch ${branch}` : 'Protected workspace';
  return (
    <div
      role="status"
      aria-label={label}
      title="This workspace is protected. Changes come from the connected branch."
      className={cx(
        'mx-2 flex items-center gap-2 rounded-lg border border-line bg-surface-3 px-2.5 py-1.5 text-xs text-ink-2',
        collapsed && 'justify-center px-0',
      )}
    >
      <Lock size={14} aria-hidden="true" style={color ? { color } : undefined} />
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate">{branch ? `Protected, ${branch}` : 'Protected'}</span>
      )}
    </div>
  );
}
