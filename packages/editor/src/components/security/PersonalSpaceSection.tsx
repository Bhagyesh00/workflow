/**
 * P6-33: Settings > Security, personal space: publishing and sharing switches (default on), each with the
 * existing count and a confirm on turning off; turning off undoes nothing. Gate `securitySettings:manage`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../api/client';
import { securityApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { SecurityPolicy, SecurityPolicyPatch } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { confirmDialog } from '../ui/Dialog';
import { Switch } from '../ui/Field';
import { Callout, Spinner } from '../ui/misc';

type Flag = keyof SecurityPolicyPatch;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Row {
  flag: Flag;
  title: string;
  description: string;
  /** what exists today, said before the switch is turned off */
  existing: (policy: SecurityPolicy) => string;
  confirmTitle: string;
  confirmBody: (policy: SecurityPolicy) => string;
  on: string;
  off: string;
}

const ROWS: readonly Row[] = [
  {
    flag: 'personalSpacePublishing',
    title: 'Publishing from personal projects',
    description: 'Members can publish the workflows in their own personal project.',
    existing: (p) =>
      `${plural(p.publishedPersonalWorkflowsCount, 'workflow is', 'workflows are')} published from personal projects now.`,
    confirmTitle: 'Turn off publishing from personal projects?',
    confirmBody: (p) =>
      `Members will not be able to publish workflows in their personal projects. ${plural(
        p.publishedPersonalWorkflowsCount,
        'workflow stays',
        'workflows stay',
      )} published; unpublish them yourself if they should stop.`,
    on: 'Publishing from personal projects is on',
    off: 'Publishing from personal projects is off',
  },
  {
    flag: 'personalSpaceSharing',
    title: 'Sharing from personal projects',
    description: 'Members can share their personal workflows and credentials with other projects.',
    existing: (p) =>
      `${plural(p.sharedPersonalWorkflowsCount, 'workflow is', 'workflows are')} and ${plural(
        p.sharedPersonalCredentialsCount,
        'credential is',
        'credentials are',
      )} shared from personal projects now.`,
    confirmTitle: 'Turn off sharing from personal projects?',
    confirmBody: (p) =>
      `Members will not be able to share workflows or credentials from their personal projects. ${plural(
        p.sharedPersonalWorkflowsCount,
        'workflow',
        'workflows',
      )} and ${plural(
        p.sharedPersonalCredentialsCount,
        'credential',
        'credentials',
      )} stay shared; unshare them yourself if they should stop.`,
    on: 'Sharing from personal projects is on',
    off: 'Sharing from personal projects is off',
  },
];

export function PersonalSpaceSection() {
  const { can } = usePermissions();
  const canManage = can('securitySettings:manage');
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: queryKeys.securitySettings,
    queryFn: securityApi.get,
    enabled: canManage,
  });

  const update = useMutation({
    mutationFn: (patch: SecurityPolicyPatch) => securityApi.update(patch),
    onSuccess: async (next, patch) => {
      queryClient.setQueryData(queryKeys.securitySettings, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      const [flag] = Object.keys(patch) as Flag[];
      const row = ROWS.find((r) => r.flag === flag);
      if (row) toast.success(next[flag] ? row.on : row.off);
    },
    onError: (error) => toast.error('Could not change the setting', errorMessage(error)),
  });

  if (!canManage) {
    return <Callout>Only admins can change the personal space settings.</Callout>;
  }
  if (policy.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
        <Spinner /> Loading personal space settings
      </div>
    );
  }
  if (policy.isError || !policy.data) {
    return (
      <Callout tone="err" title="Could not load the personal space settings">
        {errorMessage(policy.error)}
      </Callout>
    );
  }
  const current = policy.data;

  const change = async (row: Row, next: boolean) => {
    if (!next) {
      const ok = await confirmDialog({
        title: row.confirmTitle,
        description: row.confirmBody(current),
        confirmLabel: 'Turn off',
        tone: 'danger',
      });
      if (!ok) return;
    }
    update.mutate({ [row.flag]: next });
  };

  return (
    <>
      {ROWS.map((row) => (
        <div
          key={row.flag}
          className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4"
        >
          <div className="min-w-0">
            <p className="font-semibold text-ink">{row.title}</p>
            <p className="mt-1 text-sm text-ink-2">{row.description}</p>
            <p className="mt-1 text-sm text-ink-2" data-testid={`${row.flag}-count`}>
              {row.existing(current)}
            </p>
          </div>
          <Switch
            label={row.title}
            checked={current[row.flag]}
            disabled={update.isPending}
            onChange={(next) => void change(row, next)}
          />
        </div>
      ))}
    </>
  );
}
