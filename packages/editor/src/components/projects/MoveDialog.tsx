/**
 * P6-44: move a workflow, credential or folder to another project, with the preview (restricted and
 * unpublish lists), credential picks and "Moving will remove any existing sharing".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../api/client';
import { credentialsApi, foldersApi, transferApi, workflowsApi } from '../../api/endpoints';
import { queryKeys, useProjects } from '../../api/queries';
import type { CredentialSummary, ProjectOwnedFields, TransferPreview } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, Select } from '../ui/Field';
import { Callout, PageLoader } from '../ui/misc';
import { MOVE_REMOVES_SHARING_TEXT } from './ShareDialog';

export interface MoveDialogProps {
  resource: 'workflow' | 'credential' | 'folder';
  id: string;
  onClose(): void;
}

interface MoveRow extends ProjectOwnedFields {
  id: string;
  name: string;
  /** a workflow's credential ids (the picks of the move) */
  usedCredentialIds?: string[];
  /** P6-15: a private credential (each user connects their own account) */
  isResolvable?: boolean;
}

/** P6-15: the move note of a private credential */
export const PRIVATE_MOVE_TEXT =
  "This credential is private. It can't move to a personal project, and users who can't reach the destination lose their own connection.";

async function loadRow(resource: MoveDialogProps['resource'], id: string): Promise<MoveRow> {
  if (resource === 'credential') return credentialsApi.get(id);
  if (resource === 'folder') return foldersApi.get(id);
  const wf = await workflowsApi.get(id);
  const used = new Set<string>();
  for (const node of wf.nodes)
    for (const ref of Object.values(node.credentials ?? {})) if (ref.id) used.add(ref.id);
  return { ...wf, usedCredentialIds: [...used] };
}

const previewApi = {
  workflow: (id: string, to: string) => transferApi.previewWorkflow(id, to),
  credential: (id: string, to: string) => transferApi.previewCredential(id, to),
  folder: (id: string, to: string) => transferApi.previewFolder(id, to),
};

function ViolationList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold text-ink">{title}</p>
      <ul className="list-disc pl-5 text-ink-2">
        {items.map((text, i) => (
          // messages can repeat: the key is the text plus its count so far
          <li key={`${text}:${items.slice(0, i).filter((t) => t === text).length}`}>{text}</li>
        ))}
      </ul>
    </div>
  );
}

export function MoveDialog({ resource, id, onClose }: MoveDialogProps) {
  const queryClient = useQueryClient();
  const row = useQuery({
    queryKey: ['move-dialog', resource, id],
    queryFn: () => loadRow(resource, id),
    retry: false,
  });
  const projects = useProjects();
  const [destination, setDestination] = useState('');
  const [shared, setShared] = useState<string[]>([]);

  const data = row.data;
  const homeId = data?.homeProject?.id ?? data?.projectId;
  const canMove = !data?.scopes || data.scopes.includes(`${resource}:move`);
  // P6-15: a private credential never moves to a personal project
  const isPrivate = resource === 'credential' && data?.isResolvable === true;
  const targets = (projects.data ?? []).filter(
    (p) =>
      p.id !== homeId && p.scopes?.includes(`${resource}:create`) && !(isPrivate && p.type === 'personal'),
  );
  const target = targets.find((p) => p.id === destination);

  const preview = useQuery({
    queryKey: queryKeys.transferPreview(resource, id, destination),
    queryFn: (): Promise<TransferPreview> => previewApi[resource](id, destination),
    enabled: Boolean(destination) && canMove,
    retry: false,
  });

  const credentials = useQuery({
    queryKey: ['move-dialog', 'credentials'],
    queryFn: () => credentialsApi.list(undefined, { includeScopes: true }),
    enabled: resource !== 'credential',
    retry: false,
  });
  const picks: CredentialSummary[] = (credentials.data ?? []).filter(
    (c) =>
      resource !== 'credential' &&
      c.projectId === homeId &&
      !c.isGlobal &&
      c.scopes?.includes('credential:share') &&
      (resource === 'folder' || data?.usedCredentialIds?.includes(c.id)) &&
      !c.sharedWithProjects?.some((p) => p.id === destination),
  );

  const restricted = preview.data?.restricted ?? [];
  const unpublish = (preview.data?.unpublishReasons ?? []).map((v) => v.message);
  const toUnpublish = (preview.data?.workflowsToUnpublish ?? []).map((w) => w.name);

  const move = useMutation({
    mutationFn: () => {
      const shareCredentials = shared.filter((cid) => picks.some((c) => c.id === cid));
      if (resource === 'workflow')
        return transferApi.transferWorkflow(id, {
          destinationProjectId: destination,
          ...(shareCredentials.length > 0 ? { shareCredentials } : {}),
        });
      if (resource === 'folder')
        return transferApi.transferFolder(id, {
          destinationProjectId: destination,
          ...(shareCredentials.length > 0 ? { shareCredentials } : {}),
        });
      return transferApi.transferCredential(id, { destinationProjectId: destination });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success(`Moved ${data?.name ?? `the ${resource}`} to ${target?.name ?? 'the project'}`);
      onClose();
    },
    onError: (error) => toast.error(`Couldn't move the ${resource}`, errorMessage(error)),
  });

  const ready = Boolean(destination) && canMove && preview.isSuccess && restricted.length === 0;

  let body: ReactNode;
  if (row.isLoading || projects.isLoading) body = <PageLoader label="Loading" />;
  else if (row.isError)
    body = <Callout tone="err">{`Couldn't load the ${resource}: ${errorMessage(row.error)}`}</Callout>;
  else if (!canMove)
    body = <Callout tone="info">{`You don't have permission to move this ${resource}.`}</Callout>;
  else
    body = (
      <div className="flex flex-col gap-4 text-sm">
        <Callout tone="warn">{MOVE_REMOVES_SHARING_TEXT}</Callout>
        {isPrivate && <Callout tone="warn">{PRIVATE_MOVE_TEXT}</Callout>}
        {targets.length === 0 ? (
          <p className="text-ink-2">{`No other project can take this ${resource}.`}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-ink">Destination project</span>
            <Select
              aria-label="Destination project"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                setShared([]);
              }}
            >
              <option value="">Select a project</option>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.type === 'personal' ? `${p.name} (personal)` : p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {destination && preview.isLoading && <PageLoader label="Checking the move" />}
        {destination && preview.isError && (
          <Callout tone="err">{`Couldn't check the move: ${errorMessage(preview.error)}`}</Callout>
        )}
        {preview.isSuccess && (
          <div className="flex flex-col gap-3" data-testid="move-preview">
            {preview.data.checkFailed && (
              <Callout tone="warn">
                Couldn't check every rule of the destination. The lists below can be incomplete.
              </Callout>
            )}
            {restricted.length > 0 && (
              <ViolationList
                title={`${target?.name ?? 'The destination'} doesn't allow this move`}
                items={restricted.map((v) => v.message)}
              />
            )}
            {unpublish.length > 0 && (
              <ViolationList title="This workflow will be unpublished" items={unpublish} />
            )}
            {toUnpublish.length > 0 && (
              <ViolationList title="These workflows will be unpublished" items={toUnpublish} />
            )}
            {resource !== 'credential' && picks.length > 0 && (
              <fieldset
                className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
                aria-label="Credentials to share"
              >
                <p className="font-semibold text-ink">
                  {resource === 'workflow'
                    ? 'Also share the credentials this workflow uses'
                    : 'Also share credentials with the destination'}
                </p>
                {picks.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={c.name}
                    checked={shared.includes(c.id)}
                    onChange={(e) =>
                      setShared(e.target.checked ? [...shared, c.id] : shared.filter((x) => x !== c.id))
                    }
                  />
                ))}
              </fieldset>
            )}
          </div>
        )}
      </div>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!move.isPending}
      size="sm"
      title={`Move ${data?.name ?? resource} to a project`}
      description={
        resource === 'folder'
          ? 'The folder moves with all the workflows and folders inside it.'
          : `Choose the project that will own this ${resource}.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={move.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={move.isPending} onClick={() => move.mutate()}>
            Move
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
