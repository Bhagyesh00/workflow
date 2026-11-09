/**
 * P6-44: share a workflow or credential with projects (a project picker; the full list goes to PUT
 * `/:id/share`). A personal credential without `credential:share` shows "Sharing is disabled in personal
 * spaces..."; `credential:shareGlobally` adds the share with all users control (`isGlobal`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../api/client';
import { credentialsApi, projectsApi, sharingApi, workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { ProjectOwnedFields, ProjectRef } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, Switch, TextInput } from '../ui/Field';
import { Callout, PageLoader } from '../ui/misc';

export interface ShareDialogProps {
  resource: 'workflow' | 'credential';
  id: string;
  onClose(): void;
}

export const personalSpaceSharingText = (resource: 'workflow' | 'credential') =>
  `Sharing is disabled in personal spaces. Move the ${resource} to a team project to share it.`;

export const MOVE_REMOVES_SHARING_TEXT = 'Moving will remove any existing sharing.';

interface ShareRow extends ProjectOwnedFields {
  id: string;
  name: string;
  isGlobal?: boolean;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function ShareDialog({ resource, id, onClose }: ShareDialogProps) {
  const queryClient = useQueryClient();
  const row = useQuery({
    queryKey: ['share-dialog', resource, id],
    queryFn: async (): Promise<ShareRow> =>
      resource === 'workflow' ? workflowsApi.get(id) : credentialsApi.get(id),
    retry: false,
  });
  const candidates = useQuery({
    queryKey: queryKeys.sharingCandidates,
    queryFn: projectsApi.sharingCandidates,
    retry: false,
  });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [globalPick, setGlobalPick] = useState<boolean | null>(null);
  const [search, setSearch] = useState('');

  const data = row.data;
  const sharedNow = (data?.sharedWithProjects ?? []).map((p) => p.id);
  const selected = picked ?? sharedNow;
  const isGlobal = globalPick ?? data?.isGlobal ?? false;
  const scopes = data?.scopes;
  const canShare = !scopes || scopes.includes(`${resource}:share`);
  const canShareGlobally = resource === 'credential' && Boolean(scopes?.includes('credential:shareGlobally'));
  const homeId = data?.homeProject?.id ?? data?.projectId;
  const personalHome = data?.homeProject?.type === 'personal';
  const options: ProjectRef[] = (candidates.data ?? []).filter(
    (p) => p.id !== homeId && p.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const sharesChanged = !sameSet(selected, sharedNow);
  const globalChanged = canShareGlobally && isGlobal !== (data?.isGlobal ?? false);
  const dirty = (canShare && sharesChanged) || globalChanged;

  const save = useMutation({
    mutationFn: async () => {
      if (globalChanged) await credentialsApi.update(id, { isGlobal });
      if (canShare && sharesChanged) {
        if (resource === 'workflow') await sharingApi.shareWorkflow(id, selected);
        else await sharingApi.shareCredential(id, selected);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success(`Updated sharing for ${data?.name ?? `the ${resource}`}`);
      onClose();
    },
    onError: (error) => toast.error("Couldn't update sharing", errorMessage(error)),
  });

  const toggle = (projectId: string, on: boolean) =>
    setPicked(
      on ? [...selected.filter((x) => x !== projectId), projectId] : selected.filter((x) => x !== projectId),
    );

  const noPermission = personalHome
    ? personalSpaceSharingText(resource)
    : `You don't have permission to share this ${resource}.`;

  let body: ReactNode;
  if (row.isLoading || candidates.isLoading) body = <PageLoader label="Loading" />;
  else if (row.isError)
    body = <Callout tone="err">{`Couldn't load the ${resource}: ${errorMessage(row.error)}`}</Callout>;
  else if (!canShare && !canShareGlobally) body = <Callout tone="info">{noPermission}</Callout>;
  else
    body = (
      <div className="flex flex-col gap-4 text-sm">
        {canShareGlobally && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <div>
              <p className="font-semibold text-ink">Share with all users</p>
              <p className="text-ink-2">
                Everyone in the workspace can use this credential in their workflows. They can't see or change
                its data.
              </p>
            </div>
            <Switch checked={isGlobal} onChange={setGlobalPick} label="Share with all users" />
          </div>
        )}
        {!canShare ? (
          <Callout tone="info">{noPermission}</Callout>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="font-semibold text-ink">Share with projects</p>
            {candidates.isError ? (
              <Callout tone="err">{`Couldn't load projects: ${errorMessage(candidates.error)}`}</Callout>
            ) : (
              <>
                <TextInput
                  aria-label="Search projects"
                  placeholder="Search projects"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  disabled={isGlobal}
                />
                <fieldset
                  aria-label="Projects"
                  className="m-0 flex min-w-0 max-h-60 flex-col gap-1 overflow-y-auto rounded-lg border border-line p-2"
                >
                  {options.length === 0 && <p className="text-ink-3">No projects to share with.</p>}
                  {options.map((p) => (
                    <Checkbox
                      key={p.id}
                      label={p.type === 'personal' ? `${p.name} (personal)` : p.name}
                      checked={selected.includes(p.id)}
                      disabled={isGlobal}
                      onChange={(e) => toggle(p.id, e.target.checked)}
                    />
                  ))}
                </fieldset>
              </>
            )}
          </div>
        )}
        <p className="text-ink-3">{MOVE_REMOVES_SHARING_TEXT}</p>
      </div>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!save.isPending}
      size="sm"
      title={`Share ${data?.name ?? resource}`}
      description={`Choose who can use this ${resource}. People in a project you share it with can use it, but can't delete it.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
