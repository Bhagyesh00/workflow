/**
 * P6-76 (L6): the sidebar's branch name with Pull and Push (n8n's disable rules: Pull needs `sourceControl:pull`,
 * Push needs `sourceControl:push` and is off on a protected workspace); hidden while the workspace has no Git
 * connection or the user holds neither scope. The server stays the lock.
 */
import { ArrowDownToLine, ArrowUpFromLine, GitBranch } from 'lucide-react';
import { useState } from 'react';
import { useProjects, useSourceControlPreferences } from '../../api/queries';
import type { PullResult } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { useProtectedWorkspace } from '../../lib/protected';
import { toast } from '../../stores/ui-store';
import { Button, IconButton } from '../ui/Button';
import { PullModal } from './PullModal';
import { PullResultModal } from './PullResultModal';
import { PushModal } from './PushModal';

export interface SidebarSourceControlProps {
  /** the sidebar is collapsed to icons */
  collapsed: boolean;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function SidebarSourceControl({ collapsed }: SidebarSourceControlProps) {
  const preferences = useSourceControlPreferences();
  const projects = useProjects();
  const { can } = usePermissions();
  const protectedWorkspace = useProtectedWorkspace();
  const [pushOpen, setPushOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [pullResult, setPullResult] = useState<PullResult | null>(null);

  const data = preferences.data;
  const canPull = can('sourceControl:pull');
  // a project admin pushes its own projects: the scope can come from a project instead of the workspace role
  const canPush =
    can('sourceControl:push') || (projects.data ?? []).some((p) => can('sourceControl:push', p));
  if (!data?.connected || (!canPull && !canPush)) return null;

  const color = HEX_COLOR.test(data.branchColor) ? data.branchColor : '#5296D6';
  const pushOff = protectedWorkspace || !canPush;
  const pushTitle = protectedWorkspace ? 'This workspace is protected: push is off' : undefined;

  return (
    <>
      <fieldset
        aria-label="Git"
        className={
          collapsed
            ? 'm-0 flex min-w-0 flex-col items-center gap-1 border-0 p-0 py-1'
            : 'm-0 flex min-w-0 flex-col gap-2 border-0 px-1 py-1'
        }
      >
        <div className="flex items-center gap-2 text-sm text-ink" title={`Branch ${data.branchName}`}>
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          {collapsed ? (
            <GitBranch size={14} className="text-ink-2" />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium">{data.branchName}</span>
          )}
        </div>
        {collapsed ? (
          <>
            <IconButton label="Pull" size="sm" disabled={!canPull} onClick={() => setPullOpen(true)}>
              <ArrowDownToLine size={14} />
            </IconButton>
            <IconButton label="Push" size="sm" disabled={pushOff} onClick={() => setPushOpen(true)}>
              <ArrowUpFromLine size={14} />
            </IconButton>
          </>
        ) : (
          <div className="flex gap-1.5">
            <Button
              size="sm"
              className="flex-1"
              icon={<ArrowDownToLine size={13} />}
              disabled={!canPull}
              onClick={() => setPullOpen(true)}
            >
              Pull
            </Button>
            <Button
              size="sm"
              className="flex-1"
              icon={<ArrowUpFromLine size={13} />}
              disabled={pushOff}
              title={pushTitle}
              onClick={() => setPushOpen(true)}
            >
              Push
            </Button>
          </div>
        )}
      </fieldset>
      <PushModal
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        onPushed={(result) => {
          setPushOpen(false);
          toast.success(
            `Pushed ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'} to ${data.branchName}`,
          );
        }}
      />
      <PullModal
        open={pullOpen}
        onClose={() => setPullOpen(false)}
        onPulled={(result) => {
          setPullOpen(false);
          setPullResult(result);
        }}
      />
      <PullResultModal result={pullResult} onClose={() => setPullResult(null)} />
    </>
  );
}
