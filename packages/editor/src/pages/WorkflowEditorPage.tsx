/** The workflow editor: canvas, node creator, NDV, Doctor, versions, logs and run controls. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeParameters, NodeTypeDescription, WorkflowSettings } from '@workflow/workflow';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { LayoutGrid, Plus, Sparkles, StickyNote } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { executionsApi, workflowsApi } from '../api/endpoints';
import { queryKeys, useAiBuilderFeature, useMe, useNodeTypes } from '../api/queries';
import type { PublishBody } from '../api/types';
import { BuilderPanel } from '../components/assistant/BuilderPanel';
import type { CanvasActions } from '../components/canvas/actions';
import { FlowCanvas } from '../components/canvas/FlowCanvas';
import { NodeCreator } from '../components/canvas/NodeCreator';
import { SelectionToolbar } from '../components/canvas/SelectionToolbar';
import { NodeDetailsView } from '../components/ndv/NodeDetailsView';
import { Button, IconButton } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { ArchivedBanner } from '../components/workflow/ArchivedBanner';
import { ConvertDialog } from '../components/workflow/ConvertDialog';
import { DoctorPanel } from '../components/workflow/DoctorPanel';
import { LogPanel } from '../components/workflow/LogPanel';
import { VersionsPanel } from '../components/workflow/VersionsPanel';
import { WorkflowSettingsModal } from '../components/workflow/WorkflowSettingsModal';
import { onVersionRestored } from '../features/builder/session-actions';
import { useEditorCommands } from '../features/command-bar/editor-commands';
import { addNodeFromDescription } from '../features/editor/add-node';
import { CanvasContextMenu } from '../features/editor/CanvasContextMenu';
import { EditorTopBar, ShortcutsDialog } from '../features/editor/EditorTopBar';
import { ExecuteBar } from '../features/editor/ExecuteBar';
import {
  type EditorDeps,
  listenForTestEvent,
  overwriteLatest,
  reloadLatest,
  reportDeactivation,
  runWorkflow,
  saveWorkflow,
  stopExecution,
  webhookTriggerToListen,
} from '../features/editor/editor-actions';
import { ImportUrlDialog } from '../features/editor/ImportUrlDialog';
import { OpenCredentialHost } from '../features/editor/OpenCredentialHost';
import { publishWorkflow, unpublishWorkflow } from '../features/editor/publish-actions';
import { RenameNodeDialog } from '../features/editor/RenameNodeDialog';
import { tidyUp } from '../features/editor/tidy-up';
import { useAutosave } from '../features/editor/useAutosave';
import { useDirtyNodes } from '../features/editor/useDirtyNodes';
import { useEditorShortcuts } from '../features/editor/useEditorShortcuts';
import { addStickyAt, duplicateWorkflow } from '../features/editor/workflow-commands';
import { ReviewStatusBanner } from '../features/reviews/ReviewStatusBanner';
import {
  archiveWorkflow,
  deleteArchivedWorkflow,
  unarchiveWorkflow,
} from '../features/workflows/archive-actions';
import { issuesByNode, lintWorkflow } from '../lib/doctor';
import { isTriggerDescription } from '../lib/ports';
import { getMainParents, getNode } from '../lib/workflow-ops';
import { useBuilderStore } from '../stores/builder-store';
import { useChatStore } from '../stores/chat-store';
import { useRunStore } from '../stores/run-store';
import { toast, useUiStore } from '../stores/ui-store';
import { useWorkflowStore } from '../stores/workflow-store';

const store = () => useWorkflowStore.getState();

function EditorSurface({ deps }: { deps: EditorDeps }) {
  const flow = useReactFlow();
  const nodeTypes = useNodeTypes();
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const pinData = useWorkflowStore((s) => s.pinData);
  const stickyNotes = useWorkflowStore((s) => s.stickyNotes);
  const nodeGroups = useWorkflowStore((s) => s.nodeGroups);
  const selection = useWorkflowStore((s) => s.selection);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const meta = useWorkflowStore((s) => s.meta);
  const loadCount = useWorkflowStore((s) => s.loadCount);
  const runData = useRunStore((s) => s.runData);
  const runningNodes = useRunStore((s) => s.runningNodes);
  const logs = useRunStore((s) => s.logs);
  const clearLogs = useRunStore((s) => s.clearLogs);
  const ui = useUiStore();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const dirtyNodes = useDirtyNodes();
  // P5-09, P5-62: the builder's entry (editors and above) and its canvas lock while a turn streams
  const aiBuilder = useAiBuilderFeature();
  const canWrite = useMe().data?.role !== 'viewer';
  const builderStreaming = useBuilderStore((s) => s.streaming);
  useEffect(() => {
    useBuilderStore.getState().setDeps({ ...deps, flow });
    return () => useBuilderStore.getState().setDeps(null);
  }, [deps, flow]);

  const graph = useMemo(
    () => ({ nodes, connections, pinData, stickyNotes, nodeGroups }),
    [nodes, connections, pinData, stickyNotes, nodeGroups],
  );
  // the group rules need node type descriptions (triggers, sub-nodes)
  useEffect(() => {
    store().setNodeTypeLookup((type) => nodeTypes.get(type));
  }, [nodeTypes]);
  const issues = useMemo(
    () => lintWorkflow({ nodes, connections, pinData, active: meta.active }, nodeTypes),
    [nodes, connections, pinData, meta.active, nodeTypes],
  );
  const issueMap = useMemo(() => issuesByNode(issues), [issues]);
  const hasTrigger = nodes.some((n) => isTriggerDescription(nodeTypes.get(n.type)));
  // reads the store; re-evaluated on every render caused by graph changes
  const listenNode = webhookTriggerToListen(deps);

  const save = useCallback(async () => {
    setSaving(true);
    await saveWorkflow(deps);
    setSaving(false);
  }, [deps]);
  const execute = useCallback(() => void runWorkflow(deps), [deps]);
  const executeNode = useCallback(
    (name: string) => void runWorkflow(deps, { destinationNode: name }),
    [deps],
  );

  const focusNode = useCallback(
    (name: string) => {
      const node = getNode(store(), name);
      if (!node) return;
      store().select({ nodes: [name], stickies: [], edges: [] });
      void flow.setCenter(node.position[0] + 110, node.position[1] + 32, { zoom: 1.1, duration: 300 });
    },
    [flow],
  );

  const addSticky = useCallback(() => {
    addStickyAt(flow);
  }, [flow]);

  const handlers = useMemo(
    () => ({
      onSave: () => void save(),
      onExecute: execute,
      onAddSticky: addSticky,
      descriptions: nodeTypes,
    }),
    [save, execute, addSticky, nodeTypes],
  );
  useEditorShortcuts(handlers);
  useEditorCommands({ deps, flow, save, execute });
  useAutosave(deps);

  const actionDeps = useMemo(() => ({ navigate: deps.navigate, queryClient }), [deps.navigate, queryClient]);

  const pickNode = (description: NodeTypeDescription, parameters?: NodeParameters) =>
    addNodeFromDescription(description, {
      flow,
      descriptions: nodeTypes,
      creator: ui.creatorContext,
      parameters,
    });

  const actions: CanvasActions = useMemo(
    () => ({
      openNdv: (name) => useUiStore.getState().openNdv(name),
      executeNode,
      toggleDisabled: (name) => store().toggleDisabled([name]),
      removeNode: (name) => store().removeNodes([name]),
      addFromOutput: (name, type, index) =>
        useUiStore
          .getState()
          .openCreator({ connectFrom: { source: name, sourceType: type, sourceIndex: index } }),
      addSubNode: (name, type, index) =>
        useUiStore
          .getState()
          .openCreator({ connectTo: { target: name, targetType: type, targetIndex: index } }),
      insertOnEdge: (ref) => useUiStore.getState().openCreator({ insertOn: ref }),
      removeEdge: (ref) => store().disconnect(ref),
      updateSticky: (id, patch, history) => store().updateSticky(id, patch, { history }),
      removeSticky: (id) => store().removeStickies([id]),
      openContextMenu: (name, at) => {
        if (!store().selection.nodes.includes(name))
          store().select({ nodes: [name], stickies: [], edges: [] });
        useUiStore.getState().openContextMenu({ ...at, target: { type: 'node', nodeName: name } });
      },
    }),
    [executeNode],
  );

  const publish = async (run: () => Promise<boolean>) => {
    setActivating(true);
    await run();
    setActivating(false);
  };

  const creatorFilter = ui.creatorContext.connectTo
    ? { outputType: ui.creatorContext.connectTo.targetType }
    : ui.creatorContext.connectFrom?.sourceType === 'main' || ui.creatorContext.insertOn
      ? { needsMainInput: true }
      : {};

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorTopBar
        issues={issues}
        saving={saving}
        activating={activating}
        onSave={() => void save()}
        onPublish={(body: PublishBody) => void publish(() => publishWorkflow(deps, body))}
        onUnpublish={() => void publish(() => unpublishWorkflow(deps))}
        onDuplicate={() => void duplicateWorkflow(deps)}
        onArchive={() => {
          const id = store().meta.id;
          if (id) void archiveWorkflow(id, actionDeps);
        }}
        onUnarchive={() => {
          const id = store().meta.id;
          if (id) void unarchiveWorkflow(id, actionDeps);
        }}
        onDelete={() => {
          const id = store().meta.id;
          if (id) void deleteArchivedWorkflow(id, actionDeps);
        }}
      />
      <ArchivedBanner />
      <ReviewStatusBanner />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" data-testid="canvas">
          <FlowCanvas
            graph={graph}
            descriptions={nodeTypes}
            runData={runData}
            runningNodes={runningNodes}
            selection={selection}
            issues={issueMap}
            readOnly={readOnly || builderStreaming}
            actions={actions}
            fitKey={loadCount}
            onSelectionChange={(sel) => store().select(sel)}
            onContextMenu={(menu) => useUiStore.getState().openContextMenu(menu)}
            dirtyNodes={dirtyNodes}
            onDragStart={() => store().checkpoint()}
            onMove={(positions, stickies) => {
              if (Object.keys(positions).length) store().moveNodes(positions, { history: false });
              for (const [id, position] of Object.entries(stickies))
                store().updateSticky(id, { position }, { history: false });
            }}
            onConnect={(ref) => store().connect(ref)}
            onConnectToEmpty={(from, position) => {
              const [, type, index] = from.handleId.split(':');
              useUiStore.getState().openCreator({
                connectFrom: {
                  source: from.nodeName,
                  sourceType: type as 'main',
                  sourceIndex: Number(index),
                },
                position,
              });
            }}
          >
            {nodes.length === 0 && stickyNotes.length === 0 && !readOnly && (
              <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
                <div className="pointer-events-auto flex flex-col items-center gap-3 text-center">
                  <button
                    type="button"
                    onClick={() => ui.openCreator()}
                    className="grid size-24 place-items-center rounded-3xl border-2 border-dashed border-line-strong bg-surface text-4xl font-light text-ink-3 transition-colors hover:border-brand hover:text-brand"
                    aria-label="Add the first step"
                  >
                    +
                  </button>
                  <p className="font-display text-md font-semibold">Add the first step</p>
                  <p className="max-w-64 text-sm text-ink-2">
                    Pick a trigger: a schedule, a webhook, an app event or a manual start.
                  </p>
                  {aiBuilder.enabled && canWrite && (
                    <Button
                      icon={<Sparkles size={15} />}
                      onClick={() => useBuilderStore.getState().setOpen(true)}
                    >
                      Build with AI
                    </Button>
                  )}
                </div>
              </div>
            )}
            <ExecuteBar
              onExecute={execute}
              onStop={() => void stopExecution()}
              readOnly={readOnly}
              listenNode={listenNode}
            />
            {!readOnly && (
              <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => ui.openCreator()}>
                  Add node
                </Button>
                <IconButton
                  label="Add sticky note"
                  variant="secondary"
                  onClick={addSticky}
                  className="self-end"
                >
                  <StickyNote size={15} />
                </IconButton>
                <IconButton
                  label="Tidy up"
                  variant="secondary"
                  onClick={() => {
                    const sel = store().selection;
                    tidyUp(
                      flow,
                      sel.nodes.length >= 2 ? { nodes: sel.nodes, stickies: sel.stickies } : undefined,
                    );
                  }}
                  className="self-end"
                >
                  <LayoutGrid size={15} />
                </IconButton>
              </div>
            )}
            <SelectionToolbar />
            <CanvasContextMenu deps={deps} execute={execute} />
          </FlowCanvas>
        </div>
        {ui.sidePanel === 'creator' && (
          <NodeCreator
            nodeTypes={nodeTypes.list}
            onPick={pickNode}
            onClose={() => ui.setSidePanel(null)}
            noTriggerYet={!hasTrigger}
            replaceFor={ui.replaceTarget ?? undefined}
            {...creatorFilter}
          />
        )}
        {ui.sidePanel === 'doctor' && (
          <DoctorPanel issues={issues} onClose={() => ui.setSidePanel(null)} onFocusNode={focusNode} />
        )}
        {ui.sidePanel === 'builder' && (
          <BuilderPanel onClose={() => useBuilderStore.getState().setOpen(false)} />
        )}
        {ui.sidePanel === 'versions' && (
          <VersionsPanel
            workflowId={meta.id}
            onClose={() => ui.setSidePanel(null)}
            onRestore={async (versionId) => {
              if (store().dirty) {
                const ok = await confirmDialog({
                  title: 'Discard unsaved changes?',
                  description: 'Restoring replaces the canvas with the selected version.',
                  confirmLabel: 'Restore version',
                  tone: 'danger',
                });
                if (!ok) return;
              }
              try {
                const dto = await workflowsApi.restoreVersion(meta.id!, versionId);
                store().load(dto);
                // the restored version replaces a builder draft; the chat goes back to that version (P5-66)
                useBuilderStore.getState().clearReview();
                void onVersionRestored(meta.id!, versionId);
                toast.success('Version restored');
                reportDeactivation(dto);
              } catch (error) {
                toast.error('Could not restore the version', errorMessage(error));
              }
            }}
          />
        )}
      </div>
      {ui.logPanelOpen && (
        <LogPanel
          logs={logs}
          runData={runData}
          onClear={clearLogs}
          onClose={() => ui.setLogPanel(false)}
          onFocusNode={focusNode}
        />
      )}
      {ui.ndvNode && (
        <NodeDetailsView
          nodeName={ui.ndvNode}
          readOnly={readOnly}
          onClose={() => ui.openNdv(null)}
          onExecuteNode={readOnly ? undefined : executeNode}
          onListen={readOnly ? undefined : (name) => void listenForTestEvent(deps, name)}
          dirtyNodes={dirtyNodes}
        />
      )}
      <ShortcutsDialog />
      <RenameNodeDialog />
      <ConvertDialog deps={deps} />
      <ImportUrlDialog />
      <OpenCredentialHost />
      <WorkflowSettingsModal
        open={ui.settingsOpen}
        onClose={() => ui.setSettingsOpen(false)}
        value={meta.settings}
        workflowId={meta.id}
        readOnly={readOnly}
        onSave={(settings: WorkflowSettings) => store().setSettings(settings)}
      />
      <Dialog
        open={ui.saveConflict}
        onClose={() => ui.setSaveConflict(false)}
        title="This workflow changed elsewhere"
        description="Someone saved a newer version while you were editing."
        size="sm"
        footer={
          <>
            <Button onClick={() => void reloadLatest()}>Load their version</Button>
            <Button variant="primary" onClick={() => void overwriteLatest(deps)}>
              Keep mine and overwrite
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          Loading their version discards your unsaved changes. Overwriting saves your canvas as the newest
          version; theirs stays in the version history.
        </p>
      </Dialog>
      <Dialog
        open={Boolean(ui.activationErrors)}
        onClose={() => ui.setActivationErrors(null)}
        title="The workflow could not be activated"
        description="Fix these problems and try again."
        size="md"
        footer={<Button onClick={() => ui.setActivationErrors(null)}>Close</Button>}
      >
        <ul className="flex flex-col gap-2">
          {ui.activationErrors?.map((error) => (
            <li key={`${error.node}:${error.message}`}>
              <Callout tone="err" title={error.node || 'Workflow'}>
                <span className="flex items-center justify-between gap-2">
                  {error.message}
                  {error.node && getNode(store(), error.node) && (
                    <Button
                      size="sm"
                      onClick={() => {
                        ui.setActivationErrors(null);
                        ui.openNdv(error.node);
                      }}
                    >
                      Open node
                    </Button>
                  )}
                </span>
              </Callout>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

/** Unsaved-changes guard for in-app navigation and tab close. */
function useUnsavedGuard(deps: EditorDeps) {
  const dirty = useWorkflowStore((s) => s.dirty);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!useWorkflowStore.getState().dirty || useWorkflowStore.getState().readOnly) return false;
    if (currentLocation.pathname === nextLocation.pathname) return false;
    // the redirect from /workflow/new to the created workflow is not leaving
    const id = useWorkflowStore.getState().meta.id;
    return !(id && nextLocation.pathname === `/workflow/${encodeURIComponent(id)}`);
  });
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onClose={() => blocker.reset?.()}
      title="Save changes before leaving?"
      description="Your latest edits to this workflow are not saved."
      size="sm"
      footer={
        <>
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            Leave without saving
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              const saved = await saveWorkflow(deps);
              if (saved) blocker.proceed?.();
              else blocker.reset?.();
            }}
          >
            Save and leave
          </Button>
        </>
      }
    />
  );
}

/** "Debug in editor": pin the trigger output of a past execution so it can be replayed. */
async function loadExecutionAsPinnedData(executionId: string) {
  try {
    const execution = await executionsApi.get(executionId);
    const runData = execution.state?.resultData?.runData ?? {};
    const store = useWorkflowStore.getState();
    let pinned = 0;
    for (const node of store.nodes) {
      const runs = runData[node.name];
      const items = runs?.[0]?.data?.main?.[0];
      const isStart = getMainParents(store.connections, node.name).length === 0;
      if (isStart && items?.length) {
        store.setPinData(node.name, items);
        pinned++;
      }
    }
    useRunStore.getState().loadExecution(execution);
    toast.info(
      pinned ? 'Loaded the run into the editor' : 'Loaded the run',
      pinned ? 'Its trigger data is pinned, so you can execute again with the same input.' : undefined,
    );
  } catch (error) {
    toast.error('Could not load the execution', errorMessage(error));
  }
}

export function WorkflowEditorPage() {
  const { id = 'new' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const nodeTypes = useNodeTypes();
  const queryClient = useQueryClient();
  const isNew = id === 'new';
  const alreadyOpen = useWorkflowStore.getState().meta.id === id;
  // viewers can open and inspect workflows but not change them
  const viewer = useMe().data?.role === 'viewer';

  const query = useQuery({
    queryKey: queryKeys.workflow(id),
    queryFn: () => workflowsApi.get(id),
    enabled: !isNew && !alreadyOpen,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!query.data) return;
    useWorkflowStore.getState().load(query.data, { readOnly: viewer });
    useRunStore.getState().reset();
    useChatStore.getState().newSession();
    const debug = search.get('debug');
    if (debug && !viewer) void loadExecutionAsPinnedData(debug);
  }, [query.data, search, viewer]);

  useEffect(() => {
    if (!isNew) return;
    useWorkflowStore.getState().reset();
    useRunStore.getState().reset();
    useChatStore.getState().newSession();
  }, [isNew]);

  // P5-62: another workflow never gets this one's builder stream or draft; the redirect from `new` to the
  // row it just created keeps them (`meta.id === id`, as `alreadyOpen`), which the first send relies on
  useEffect(() => {
    if (useWorkflowStore.getState().meta.id !== id) useBuilderStore.getState().reset();
  }, [id]);

  useEffect(
    () => () => {
      useWorkflowStore.getState().reset();
      useRunStore.getState().reset();
      useChatStore.getState().newSession();
      useBuilderStore.getState().reset();
      useUiStore.setState({
        ndvNode: null,
        sidePanel: null,
        settingsOpen: false,
        saveConflict: false,
        activationErrors: null,
        contextMenu: null,
        renameTarget: null,
        convertOpen: false,
        publishDialogOpen: false,
        workflowRenameRequested: false,
        tagsEditRequested: false,
        replaceTarget: null,
        stickyAction: null,
        importUrlOpen: false,
        openCredentialId: null,
      });
    },
    [],
  );

  const deps: EditorDeps = useMemo(
    () => ({
      navigate: (to, options) => navigate(to, options),
      descriptions: nodeTypes,
      onSaved: (dto) => {
        void queryClient.invalidateQueries({ queryKey: ['workflows'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.versions(dto.id) });
      },
    }),
    [navigate, nodeTypes, queryClient],
  );
  const guard = useUnsavedGuard(deps);

  if (query.isLoading || nodeTypes.isLoading) return <PageLoader label="Opening workflow" />;
  if (query.error) {
    return (
      <EmptyState
        title={isApiError(query.error, 404) ? 'Workflow not found' : 'Could not open the workflow'}
        description={
          isApiError(query.error, 404)
            ? 'It may have been deleted, or it belongs to another workspace.'
            : errorMessage(query.error)
        }
        action={<Button onClick={() => navigate('/workflows')}>Back to workflows</Button>}
        className="h-full"
      />
    );
  }
  return (
    <ReactFlowProvider>
      <EditorSurface deps={deps} />
      {guard}
    </ReactFlowProvider>
  );
}
