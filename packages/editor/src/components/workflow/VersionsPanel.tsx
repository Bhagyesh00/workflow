/** Version history: list, read-only preview of a snapshot, restore. */
import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { History, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys, useNodeTypes } from '../../api/queries';
import { formatDateTime, formatRelative } from '../../lib/format';
import { readOnlyActions } from '../canvas/actions';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Dialog } from '../ui/Dialog';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

function VersionPreview({
  workflowId,
  versionId,
  onRestore,
  restoring,
}: {
  workflowId: string;
  versionId: string;
  onRestore: () => void;
  restoring: boolean;
}) {
  const nodeTypes = useNodeTypes();
  const snapshot = useQuery({
    queryKey: [...queryKeys.versions(workflowId), versionId],
    queryFn: () => workflowsApi.version(workflowId, versionId),
  });
  if (snapshot.isLoading) return <PageLoader />;
  if (snapshot.error) return <Callout tone="err">{errorMessage(snapshot.error)}</Callout>;
  const data = snapshot.data!;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-ink-2">
          “{data.name}” with {data.nodes.length} node{data.nodes.length === 1 ? '' : 's'}
        </p>
        <Button variant="primary" icon={<RotateCcw size={14} />} onClick={onRestore} loading={restoring}>
          Restore this version
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line">
        <ReactFlowProvider>
          <FlowCanvas
            graph={{ nodes: data.nodes, connections: data.connections, pinData: {}, stickyNotes: [] }}
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
  const versions = useQuery({
    queryKey: queryKeys.versions(workflowId ?? 'new'),
    queryFn: () => workflowsApi.versions(workflowId!),
    enabled: Boolean(workflowId),
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

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
      <div className="wf-scroll min-h-0 flex-1 overflow-y-auto border-t border-line">
        {!workflowId ? (
          <EmptyState title="Not saved yet" description="Versions appear once the workflow has been saved." />
        ) : versions.isLoading ? (
          <PageLoader />
        ) : versions.error ? (
          <Callout tone="err" className="m-4">
            {errorMessage(versions.error)}
          </Callout>
        ) : !versions.data?.length ? (
          <EmptyState
            title="No versions yet"
            description="Every save creates a version you can come back to."
          />
        ) : (
          <ol className="relative px-4 py-3">
            {versions.data.map((v, i) => (
              <li key={v.versionId} className="relative pb-4 pl-5">
                <span
                  className={cx(
                    'absolute top-1.5 left-0 size-2.5 rounded-full border-2',
                    i === 0 ? 'border-brand bg-brand' : 'border-line-strong bg-surface',
                  )}
                />
                {i < versions.data.length - 1 && (
                  <span className="absolute top-4 bottom-0 left-[4px] w-px bg-line" />
                )}
                <button
                  type="button"
                  onClick={() => setPreview(v.versionId)}
                  className="w-full rounded-lg px-2 py-1 text-left hover:bg-surface-3"
                >
                  <span className="block text-sm font-semibold text-ink">
                    {i === 0 ? 'Current version' : formatRelative(v.createdAt)}
                  </span>
                  <span className="block text-xs text-ink-2">
                    {v.authorName}
                    {v.message ? `: ${v.message}` : ''}
                  </span>
                  <span className="block text-2xs text-ink-3">{formatDateTime(v.createdAt)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
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
            onRestore={async () => {
              setRestoring(true);
              try {
                await onRestore(preview);
                setPreview(null);
              } finally {
                setRestoring(false);
              }
            }}
          />
        )}
      </Dialog>
    </aside>
  );
}
