/**
 * Version history: list with names, descriptions and the Published badge (P3-10), rename and
 * describe a version, read-only preview of a snapshot, restore, publish an earlier version.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { diffWorkflows } from '@workflow/workflow';
import { ReactFlowProvider } from '@xyflow/react';
import { History, PencilLine, Rocket, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys, useNodeTypes } from '../../api/queries';
import type { VersionSummary } from '../../api/types';
import { requestPublish, usePublishTarget } from '../../features/editor/publish-actions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { readOnlyActions } from '../canvas/actions';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { Button, IconButton } from '../ui/Button';
import { cx } from '../ui/cx';
import { Dialog } from '../ui/Dialog';
import { TextArea, TextInput } from '../ui/Field';
import { Badge, Callout, EmptyState, PageLoader } from '../ui/misc';
import { Tabs } from '../ui/Tabs';
import { PublishTimeline } from './PublishTimeline';
import { WorkflowDiffSummary } from './WorkflowDiffSummary';

function VersionPreview({
  workflowId,
  versionId,
  onRestore,
  restoring,
  onPublish,
}: {
  workflowId: string;
  versionId: string;
  onRestore: () => void;
  restoring: boolean;
  /** null when this version cannot be published from here (read-only, or already published) */
  onPublish: (() => void) | null;
}) {
  const nodeTypes = useNodeTypes();
  const snapshot = useQuery({
    queryKey: [...queryKeys.versions(workflowId), versionId],
    queryFn: () => workflowsApi.version(workflowId, versionId),
  });
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const meta = useWorkflowStore((s) => s.meta);
  // semantic diff (NF-10): what restoring would change, ignoring layout
  const diff = useMemo(
    () =>
      snapshot.data
        ? diffWorkflows(
            { name: meta.name, nodes, connections, settings: meta.settings },
            {
              name: snapshot.data.name,
              nodes: snapshot.data.nodes,
              connections: snapshot.data.connections,
              settings: snapshot.data.settings ?? {},
            },
          )
        : null,
    [snapshot.data, nodes, connections, meta.name, meta.settings],
  );
  if (snapshot.isLoading) return <PageLoader />;
  if (snapshot.error) return <Callout tone="err">{errorMessage(snapshot.error)}</Callout>;
  const data = snapshot.data!;
  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-h-[50vh] overflow-hidden rounded-xl border border-line">
        <ReactFlowProvider>
          <FlowCanvas
            graph={{
              nodes: data.nodes,
              connections: data.connections,
              pinData: {},
              stickyNotes: [],
              nodeGroups: data.nodeGroups ?? [],
            }}
            descriptions={nodeTypes}
            runData={{}}
            runningNodes={[]}
            selection={{ nodes: [], stickies: [], edges: [] }}
            readOnly
            actions={readOnlyActions(() => undefined)}
            fitKey={versionId}
            minimap={false}
          />
        </ReactFlowProvider>
      </div>
      <aside className="flex min-h-0 flex-col gap-3">
        <div>
          {data.versionName && <p className="font-display text-md font-semibold">{data.versionName}</p>}
          <p className={data.versionName ? 'text-sm text-ink-2' : 'font-display text-md font-semibold'}>
            “{data.name}”
          </p>
          <p className="text-sm text-ink-2">
            {data.nodes.length} node{data.nodes.length === 1 ? '' : 's'}
          </p>
          {data.description && (
            <p className="mt-1 text-sm whitespace-pre-wrap text-ink">{data.description}</p>
          )}
        </div>
        <h3 className="font-sans text-sm font-semibold text-ink">Restoring changes the canvas like this</h3>
        <div className="wf-scroll min-h-0 flex-1 overflow-auto">
          {diff && <WorkflowDiffSummary diff={diff} />}
        </div>
        <Button
          variant="primary"
          icon={<RotateCcw size={14} />}
          onClick={onRestore}
          loading={restoring}
          disabled={diff?.isEmpty}
        >
          Restore this version
        </Button>
        {onPublish && (
          <Button icon={<Rocket size={14} />} onClick={onPublish}>
            Publish this version
          </Button>
        )}
      </aside>
    </div>
  );
}

export function VersionsPanel({
  workflowId,
  onClose,
  onRestore,
}: {
  workflowId?: string;
  onClose: () => void;
  onRestore: (versionId: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const versions = useInfiniteQuery({
    queryKey: [...queryKeys.versions(workflowId ?? 'new'), 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => workflowsApi.versions(workflowId!, { limit: 50, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(workflowId),
  });
  const list = versions.data?.pages.flatMap((p) => p.data) ?? [];
  const [preview, setPreview] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [tab, setTab] = useState<'versions' | 'timeline'>('versions');
  const publishedVersionId = useWorkflowStore((s) => s.meta.publishedVersionId);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const [editing, setEditing] = useState<string | null>(null);
  // a publish can name a version: refetch names, badges and the timeline after each one
  const revision = usePublishTarget((s) => s.revision);
  useEffect(() => {
    if (!workflowId || !revision) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.versions(workflowId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.publishTimeline(workflowId) });
  }, [revision, workflowId, queryClient]);

  return (
    <aside
      className="flex h-full w-[360px] flex-col border-l border-line bg-surface shadow-lift"
      aria-label="Version history"
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <History size={18} className="text-brand" />
        <h2 className="flex-1 text-md font-semibold">Version history</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close version history"
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3"
        >
          <X size={16} />
        </button>
      </div>
      <Tabs
        label="Version history views"
        size="sm"
        className="px-4"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'versions', label: 'Versions' },
          { value: 'timeline', label: 'Publish timeline' },
        ]}
      />
      {tab === 'timeline' ? (
        <div className="wf-scroll min-h-0 flex-1 overflow-y-auto border-t border-line">
          <PublishTimeline workflowId={workflowId} />
        </div>
      ) : (
        <div className="wf-scroll min-h-0 flex-1 overflow-y-auto border-t border-line">
          {!workflowId ? (
            <EmptyState
              title="Not saved yet"
              description="Versions appear once the workflow has been saved."
            />
          ) : versions.isLoading ? (
            <PageLoader />
          ) : versions.error ? (
            <Callout tone="err" className="m-4">
              {errorMessage(versions.error)}
            </Callout>
          ) : !list.length ? (
            <EmptyState
              title="No versions yet"
              description="Every save creates a version you can come back to."
            />
          ) : (
            <ol className="relative px-4 py-3">
              {list.map((v, i) => (
                <li key={v.versionId} className="relative pb-4 pl-5">
                  <span
                    className={cx(
                      'absolute top-1.5 left-0 size-2.5 rounded-full border-2',
                      i === 0 ? 'border-brand bg-brand' : 'border-line-strong bg-surface',
                    )}
                  />
                  {(i < list.length - 1 || versions.hasNextPage) && (
                    <span className="absolute top-4 bottom-0 left-[4px] w-px bg-line" />
                  )}
                  {editing === v.versionId && workflowId ? (
                    <VersionNameForm workflowId={workflowId} version={v} onDone={() => setEditing(null)} />
                  ) : (
                    <div className="group flex items-start gap-1">
                      <button
                        type="button"
                        onClick={() => setPreview(v.versionId)}
                        className="min-w-0 flex-1 rounded-lg px-2 py-1 text-left hover:bg-surface-3"
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-ink">
                            {v.versionName ?? (i === 0 ? 'Current version' : formatRelative(v.createdAt))}
                          </span>
                          {v.versionId === publishedVersionId && <Badge tone="ok">Published</Badge>}
                          {v.versionName && i === 0 && <Badge>Current</Badge>}
                        </span>
                        {v.description && (
                          <span className="block text-xs whitespace-pre-wrap text-ink">{v.description}</span>
                        )}
                        <span className="block text-xs text-ink-2">
                          {v.authorName}
                          {v.message ? `: ${v.message}` : ''}
                        </span>
                        <span className="block text-2xs text-ink-3">{formatDateTime(v.createdAt)}</span>
                      </button>
                      {!readOnly && (
                        <IconButton
                          label={`Rename version ${versionLabel(v)}`}
                          size="sm"
                          className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => setEditing(v.versionId)}
                        >
                          <PencilLine size={14} />
                        </IconButton>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {versions.hasNextPage && (
            <div className="px-4 pb-4">
              <Button
                size="sm"
                className="w-full"
                onClick={() => void versions.fetchNextPage()}
                loading={versions.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title="Version preview"
        size="full"
        bodyClassName="flex flex-col"
      >
        {preview && workflowId && (
          <VersionPreview
            workflowId={workflowId}
            versionId={preview}
            restoring={restoring}
            onPublish={
              readOnly || preview === publishedVersionId
                ? null
                : () => {
                    const versionId = preview;
                    setPreview(null);
                    void requestPublish(versionId);
                  }
            }
            onRestore={async () => {
              setRestoring(true);
              try {
                await onRestore(preview);
                setPreview(null);
              } finally {
                await queryClient.invalidateQueries({ queryKey: queryKeys.versions(workflowId) });
                setRestoring(false);
              }
            }}
          />
        )}
      </Dialog>
    </aside>
  );
}

/** a version's name, else its short id */
export function versionLabel(v: Pick<VersionSummary, 'versionId' | 'versionName'>): string {
  return v.versionName ?? v.versionId.slice(0, 8);
}

/** inline name and description of one version (PATCH /workflows/:id/versions/:versionId) */
function VersionNameForm({
  workflowId,
  version,
  onDone,
}: {
  workflowId: string;
  version: VersionSummary;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(version.versionName ?? '');
  const [description, setDescription] = useState(version.description ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await workflowsApi.updateVersion(workflowId, version.versionId, {
        versionName: name.trim() || null,
        description: description.trim() ? description : null,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.versions(workflowId) });
      onDone();
    } catch (error) {
      toast.error("Couldn't rename the version", errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line p-2"
      aria-label="Version name and description"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <TextInput
        aria-label="Version name"
        autoFocus
        value={name}
        maxLength={128}
        placeholder="Version name"
        onChange={(e) => setName(e.target.value)}
      />
      <TextArea
        aria-label="Version description"
        rows={2}
        value={description}
        maxLength={2000}
        placeholder="Description"
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
