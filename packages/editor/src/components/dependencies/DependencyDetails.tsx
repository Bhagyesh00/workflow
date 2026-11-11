/**
 * P6-86: the list of what uses a resource (and, for a workflow, what it uses). Rows the caller cannot read are
 * left out by the server. Used in the pill's popover, the "Dependencies" dialog, the delete warnings, the move
 * dialog, the folder delete and the credential sharing dialog.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { dependenciesApi } from '../../api/endpoints';
import type { DependencyDetail, DependencyKey, DependencyResourceKind } from '../../api/types';
import { cx } from '../ui/cx';
import { type ConfirmOptions, confirmDialog } from '../ui/Dialog';
import { Callout, Spinner } from '../ui/misc';

/** the keys that mean "this resource is used by that workflow" for each kind */
const USED_BY_KEYS: Record<DependencyResourceKind, DependencyKey[]> = {
  workflow: ['workflowParent', 'errorWorkflowParent'],
  credential: ['credentialId'],
  dataTable: ['dataTableId'],
};

export const usedByKeys = (kind: DependencyResourceKind): DependencyKey[] => USED_BY_KEYS[kind];

/** the heading of a group of rows, by the resource asked about and the key */
export function dependencyHeading(kind: DependencyResourceKind, key: DependencyKey): string {
  switch (key) {
    case 'workflowParent':
      return 'Called by workflows';
    case 'errorWorkflowParent':
      return 'Error workflow of';
    case 'workflowCall':
      return 'Calls workflows';
    case 'errorWorkflow':
      return 'Error workflow';
    case 'credentialId':
      return kind === 'workflow' ? 'Credentials' : 'Used by workflows';
    case 'dataTableId':
      return kind === 'workflow' ? 'Data tables' : 'Used by workflows';
  }
}

/** where a related resource opens */
export function dependencyPath(detail: Pick<DependencyDetail, 'resourceType' | 'id'>): string {
  const id = encodeURIComponent(detail.id);
  if (detail.resourceType === 'workflow') return `/workflow/${id}`;
  if (detail.resourceType === 'dataTable') return `/data-tables/${id}`;
  return '/home/credentials';
}

export function useDependencyDetails(kind: DependencyResourceKind, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['dependencies', 'details', kind, id ?? 'none'],
    queryFn: async () => (await dependenciesApi.details(kind, [id as string]))[id as string] ?? [],
    enabled: enabled && Boolean(id),
    retry: false,
    staleTime: 0,
  });
}

/** the rows grouped by key, in the order a reader expects */
function grouped(details: DependencyDetail[]): Array<[DependencyKey, DependencyDetail[]]> {
  const groups = new Map<DependencyKey, DependencyDetail[]>();
  for (const detail of details) groups.set(detail.key, [...(groups.get(detail.key) ?? []), detail]);
  return [...groups.entries()];
}

/** a plain list of rows under group headings; each row is a menu item that opens the resource */
export function DependencyList({
  kind,
  details,
  onOpen,
  className,
}: {
  kind: DependencyResourceKind;
  details: DependencyDetail[];
  onOpen?(detail: DependencyDetail): void;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <div role="menu" aria-label="Dependencies" className={cx('flex flex-col gap-2', className)}>
      {grouped(details).map(([key, rows]) => (
        <fieldset
          key={key}
          aria-label={dependencyHeading(kind, key)}
          className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0"
        >
          <p className="px-2.5 pt-1 text-2xs font-semibold tracking-wide text-ink-3 uppercase">
            {dependencyHeading(kind, key)}
          </p>
          {rows.map((row) => (
            <button
              key={`${row.key}:${row.id}`}
              type="button"
              role="menuitem"
              title={row.active ? 'Published' : undefined}
              onClick={() => {
                onOpen?.(row);
                navigate(dependencyPath(row));
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink outline-none hover:bg-surface-3 focus:bg-surface-3"
            >
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
            </button>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export interface DependencyDetailsProps {
  kind: DependencyResourceKind;
  id: string;
  onClose?(): void;
}

/** the popover body of the pill, and the body of the "Dependencies" dialog */
export function DependencyDetails({ kind, id, onClose }: DependencyDetailsProps): ReactNode {
  const query = useDependencyDetails(kind, id);
  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 px-2.5 py-2 text-sm text-ink-2" role="status">
        <Spinner size={13} /> Loading
      </p>
    );
  }
  if (query.isError) {
    return (
      <p className="px-2.5 py-2 text-sm text-err" role="alert">
        {`Couldn't load the dependencies: ${errorMessage(query.error)}`}
      </p>
    );
  }
  if (!query.data?.length) return <p className="px-2.5 py-2 text-sm text-ink-2">Nothing uses it yet.</p>;
  return <DependencyList kind={kind} details={query.data} onOpen={() => onClose?.()} />;
}

/** the rows that use the resource (`usedByKeys`); none when the call fails, so a delete is never blocked by it */
export async function usedByRows(kind: DependencyResourceKind, id: string): Promise<DependencyDetail[]> {
  try {
    const rows = (await dependenciesApi.details(kind, [id]))[id] ?? [];
    return rows.filter((row) => usedByKeys(kind).includes(row.key));
  } catch {
    return [];
  }
}

const SHOWN_NAMES = 8;

/** "Used by N workflows" with the first names: the warning a delete or a move shows */
export function UsedByNotice({ rows, children }: { rows: DependencyDetail[]; children?: ReactNode }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p className="font-semibold text-ink">
        {`Used by ${rows.length} ${rows.length === 1 ? 'workflow' : 'workflows'}`}
      </p>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-ink-2">
        {rows.slice(0, SHOWN_NAMES).map((row) => (
          <li key={`${row.key}:${row.id}`}>{row.name}</li>
        ))}
        {rows.length > SHOWN_NAMES && <li>{`and ${rows.length - SHOWN_NAMES} more`}</li>}
      </ul>
      {children}
    </div>
  );
}

/** a confirm that adds the warning when other workflows use the resource */
export async function confirmWithDependents(
  options: ConfirmOptions,
  kind: DependencyResourceKind,
  id: string,
): Promise<boolean> {
  const rows = await usedByRows(kind, id);
  if (!rows.length) return confirmDialog(options);
  return confirmDialog({
    ...options,
    description: (
      <div className="flex flex-col gap-3">
        {options.description && <p>{options.description}</p>}
        <UsedByNotice rows={rows} />
      </div>
    ),
  });
}

/**
 * Which workflows of a folder's tree other workflows use. `risky` (the folder's workflows will be archived or
 * deleted) shows a warning; otherwise it only tells that the links stay.
 */
export function FolderDependencyNotice({
  projectId,
  folderId,
  risky,
}: {
  projectId: string | undefined;
  folderId: string;
  risky: boolean;
}) {
  const query = useQuery({
    queryKey: ['dependencies', 'folder', projectId ?? 'none', folderId],
    queryFn: () => dependenciesApi.folder(projectId as string, folderId),
    enabled: Boolean(projectId),
    retry: false,
    staleTime: 0,
  });
  const workflows = query.data?.workflows ?? [];
  if (!workflows.length) return null;
  return (
    <Callout tone={risky ? 'warn' : 'info'} className="mt-3">
      <p className="m-0">
        {risky
          ? `Workflows outside this folder use ${workflows.length === 1 ? '1 workflow' : `${workflows.length} workflows`} in it. They stop working correctly.`
          : `Workflows outside this folder use ${workflows.length === 1 ? '1 workflow' : `${workflows.length} workflows`} in it. They keep working after the move.`}
      </p>
      <ul className="m-0 mt-1 list-disc pl-5">
        {workflows.slice(0, SHOWN_NAMES).map((w) => (
          <li key={w.id}>{`${w.name}, used by ${w.dependencies.map((d) => d.name).join(', ')}`}</li>
        ))}
        {workflows.length > SHOWN_NAMES && <li>{`and ${workflows.length - SHOWN_NAMES} more`}</li>}
      </ul>
    </Callout>
  );
}

/** the workflows that use one workflow (a move keeps the links, so this only informs) */
export function WorkflowUsedByNotice({ workflowId }: { workflowId: string }) {
  const query = useDependencyDetails('workflow', workflowId);
  const rows = (query.data ?? []).filter((row) => usedByKeys('workflow').includes(row.key));
  if (!rows.length) return null;
  return (
    <Callout tone="info" className="mt-3">
      <UsedByNotice rows={rows}>
        <p className="m-0 text-ink-2">They keep working after the move.</p>
      </UsedByNotice>
    </Callout>
  );
}
