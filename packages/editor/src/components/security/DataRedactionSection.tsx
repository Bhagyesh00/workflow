/**
 * P6-53 (L8): Settings > Security, the workspace redaction floor (off, production, all). Gates itself
 * on `securitySettings:manage`, as WorkflowReviewsSection.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RedactionFloor } from '@workflow/workflow';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../api/client';
import { securityApi } from '../../api/endpoints';
import { queryKeys, useProjects } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { RedactionMembersModal } from '../redaction/RedactionMembersModal';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { Select } from '../ui/Field';
import { Callout, Spinner } from '../ui/misc';

const FLOORS: ReadonlyArray<{ value: RedactionFloor; label: string; note: string }> = [
  { value: 'off', label: 'Off', note: 'Each workflow chooses what to redact.' },
  {
    value: 'production',
    label: 'Production runs',
    note: 'Every workflow redacts the data of its production executions.',
  },
  {
    value: 'all',
    label: 'All runs',
    note: 'Every workflow redacts the data of all its executions, manual runs too.',
  },
];

export function DataRedactionSection(): ReactNode {
  const { can } = usePermissions();
  const canManage = can('securitySettings:manage');
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [listing, setListing] = useState(false);
  const policy = useQuery({
    queryKey: queryKeys.securitySettings,
    queryFn: securityApi.get,
    enabled: canManage,
  });
  const projects = useProjects(canManage);
  const update = useMutation({
    mutationFn: (floor: RedactionFloor) => securityApi.update({ redaction: { floor } }),
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.securitySettings, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success('Data redaction floor saved');
    },
    onError: (error) => toast.error("Couldn't save the floor", errorMessage(error)),
  });
  if (!canManage) return null;
  if (policy.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
        <Spinner /> Loading data redaction settings
      </div>
    );
  }
  if (policy.isError || !policy.data) {
    return (
      <Callout tone="err" title="Couldn't load the data redaction settings">
        {errorMessage(policy.error)}
      </Callout>
    );
  }
  const floor = policy.data.redaction?.floor ?? 'off';

  const change = async (next: RedactionFloor) => {
    if (next === floor) return;
    const raising = next === 'all' || (next === 'production' && floor === 'off');
    const ok = await confirmDialog({
      title: raising ? 'Raise the redaction floor?' : 'Lower the redaction floor?',
      description: raising
        ? 'New runs of every workflow redact at least this much. Workflows that redact less can no longer be saved that way.'
        : 'New runs of workflows with no policy of their own stop being redacted. Runs that already happened keep their redaction.',
      confirmLabel: 'Save floor',
    });
    if (ok) update.mutate(next);
  };
  const current = FLOORS.find((f) => f.value === floor) ?? FLOORS[0];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <p className="font-semibold text-ink">Execution data redaction</p>
        <p className="mt-1 text-sm text-ink-2">
          Hide the item data of executions from everyone who cannot reveal it. The floor is the least every
          workflow in this workspace must redact.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="redaction-floor" className="text-sm font-semibold text-ink">
          Redaction floor
        </label>
        <Select
          id="redaction-floor"
          className="w-56"
          value={floor}
          disabled={update.isPending}
          onChange={(e) => void change(e.target.value as RedactionFloor)}
        >
          {FLOORS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <span className="text-sm text-ink-2">{current.note}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <label htmlFor="redaction-project" className="text-sm font-semibold text-ink">
          Who can reveal in
        </label>
        <Select
          id="redaction-project"
          className="w-56"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Choose a project</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!projectId} onClick={() => setListing(true)}>
          Show who can reveal
        </Button>
      </div>
      {projectId && (
        <RedactionMembersModal open={listing} onClose={() => setListing(false)} projectId={projectId} />
      )}
    </div>
  );
}
