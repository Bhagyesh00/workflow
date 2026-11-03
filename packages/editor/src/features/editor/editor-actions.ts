/**
 * Workflow-level commands of the editor: save (with 409 handling), run, listen for a test
 * webhook, execute a single step, activate/deactivate. They read and write the stores directly
 * so they can be used from buttons, keyboard shortcuts and the NDV alike.
 */
import {
  dirtyNodesFromDiff,
  type NodeTypeDescription,
  planPartialRun,
  type RunData,
  sortByPosition,
} from '@workflow/workflow';
import { errorMessage, isApiError } from '../../api/client';
import { executionsApi, workflowsApi } from '../../api/endpoints';
import type { ActivationErrorDetail, WorkflowDTO, WorkflowPatchBody } from '../../api/types';
import { isTriggerDescription } from '../../lib/ports';
import { getAncestors } from '../../lib/workflow-ops';
import { type RanDefinition, useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { toWorkflowBody, useWorkflowStore, type WorkflowState } from '../../stores/workflow-store';

export interface EditorDeps {
  navigate: (to: string, options?: { replace?: boolean }) => void;
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  onSaved?: (dto: WorkflowDTO) => void;
}

export interface SaveOptions {
  /** P3-17: the version this save creates is an autosave (useAutosave) */
  autosaved?: boolean;
}

function patchBody(options: SaveOptions = {}): WorkflowPatchBody {
  const s = useWorkflowStore.getState();
  return {
    name: s.meta.name,
    nodes: s.nodes,
    connections: s.connections,
    settings: s.meta.settings,
    pinData: s.pinData,
    stickyNotes: s.stickyNotes,
    nodeGroups: s.nodeGroups,
    tags: s.meta.tags,
    tagIds: s.meta.tags.map((t) => t.id),
    versionId: s.meta.versionId ?? '',
    ...(options.autosaved ? { autosaved: true } : {}),
  };
}

let saving: Promise<WorkflowDTO | null> | null = null;

/**
 * Save the open workflow (the draft; P3-10 publishing is separate). Resolves with the saved DTO, or
 * null when it failed or conflicted. While a save runs, another call joins it.
 */
export function saveWorkflow(deps: EditorDeps, options: SaveOptions = {}): Promise<WorkflowDTO | null> {
  saving ??= doSave(deps, options).finally(() => {
    saving = null;
  });
  return saving;
}

async function doSave(deps: EditorDeps, options: SaveOptions): Promise<WorkflowDTO | null> {
  const store = useWorkflowStore.getState();
  if (store.readOnly) return null;
  const revision = store.revision;
  try {
    if (!store.meta.id) {
      const dto = await workflowsApi.create(toWorkflowBody(store));
      useWorkflowStore.getState().markSaved(dto, revision);
      deps.navigate(`/workflow/${encodeURIComponent(dto.id)}`, { replace: true });
      deps.onSaved?.(dto);
      return dto;
    }
    const dto = await workflowsApi.update(store.meta.id, patchBody(options));
    useWorkflowStore.getState().markSaved(dto, revision);
    reportDeactivation(dto);
    deps.onSaved?.(dto);
    return dto;
  } catch (error) {
    if (isApiError(error, 409)) {
      useUiStore.getState().setSaveConflict(true);
      return null;
    }
    toast.error('Could not save the workflow', errorMessage(error));
    return null;
  }
}

/** A save or restore of an active workflow can come back deactivated; say so and show which nodes failed. */
export function reportDeactivation(dto: WorkflowDTO): void {
  const failure = dto.activationError;
  if (!failure) return;
  useUiStore
    .getState()
    .setActivationErrors(
      failure.details?.length ? failure.details : [{ node: '', message: failure.message }],
    );
  toast.error('Saved, but the workflow was deactivated', failure.message);
}

/** 409 resolution: drop local changes and load the latest saved version. */
export async function reloadLatest(): Promise<void> {
  const id = useWorkflowStore.getState().meta.id;
  if (!id) return;
  try {
    const dto = await workflowsApi.get(id);
    useWorkflowStore.getState().load(dto);
    useUiStore.getState().setSaveConflict(false);
    toast.info('Loaded the latest version');
  } catch (error) {
    toast.error('Could not load the workflow', errorMessage(error));
  }
}

/** 409 resolution: keep local changes and save them on top of the latest version. */
export async function overwriteLatest(deps: EditorDeps): Promise<WorkflowDTO | null> {
  const store = useWorkflowStore.getState();
  if (!store.meta.id) return null;
  try {
    const latest = await workflowsApi.get(store.meta.id);
    useWorkflowStore.setState((s) => ({ meta: { ...s.meta, versionId: latest.versionId } }));
    useUiStore.getState().setSaveConflict(false);
    const saved = await saveWorkflow(deps);
    if (saved) toast.success('Saved your version');
    return saved;
  } catch (error) {
    toast.error('Could not save the workflow', errorMessage(error));
    return null;
  }
}

/** Make sure the workflow exists on the server (and optionally has no unsaved changes). */
async function ensureSaved(deps: EditorDeps, requireClean: boolean): Promise<string | null> {
  const s = useWorkflowStore.getState();
  if (s.meta.id && (!requireClean || !s.dirty)) return s.meta.id;
  const dto = await saveWorkflow(deps);
  return dto?.id ?? null;
}

/** Trigger nodes that only start on an HTTP call (Webhook-style) need "Listen for test event". */
export function webhookTriggerToListen(deps: EditorDeps): string | null {
  const s = useWorkflowStore.getState();
  const triggers = s.nodes.filter((n) => !n.disabled && isTriggerDescription(deps.descriptions.get(n.type)));
  if (!triggers.length) return null;
  const manual = triggers.find((n) => !deps.descriptions.get(n.type)?.webhooks?.length);
  if (manual) return null;
  const pinnedWebhook = triggers.find((n) => s.pinData[n.name]);
  if (pinnedWebhook) return null;
  return triggers[0].name;
}

/** the graph a run uses, kept by the run store to find dirty nodes later (P3-06) */
export function ranDefinitionOf(
  s: Pick<WorkflowState, 'meta' | 'nodes' | 'connections' | 'pinData'>,
): RanDefinition {
  return { name: s.meta.name, nodes: s.nodes, connections: s.connections, pinData: s.pinData };
}

/** the trigger a step run starts from, as the server picks it: a manual trigger upstream, else any trigger */
function stepRunRoot(deps: EditorDeps, def: RanDefinition, destination: string): string | undefined {
  const upstream = new Set([destination, ...getAncestors(def.connections, destination)]);
  const candidates = def.nodes.filter((n) => upstream.has(n.name) && !n.disabled);
  const triggers = candidates.filter((n) => isTriggerDescription(deps.descriptions.get(n.type)));
  const manual = triggers.filter((n) => n.type === 'core.manualTrigger');
  return sortByPosition(manual.length ? manual : triggers)[0]?.name;
}

export const RUN_DATA_TOO_LARGE =
  'The data of the last run is too large to send. Execute the workflow to run every node again.';

export async function runWorkflow(
  deps: EditorDeps,
  options: { destinationNode?: string; startNode?: string } = {},
): Promise<void> {
  const run = useRunStore.getState();
  if (run.status === 'starting' || run.status === 'running') return;
  const destination = options.destinationNode
    ? deps.descriptions.get(
        useWorkflowStore.getState().nodes.find((n) => n.name === options.destinationNode)?.type ?? '',
      )
    : undefined;
  // a webhook trigger cannot "run": it waits for a call
  if (
    destination?.webhooks?.length &&
    isTriggerDescription(destination) &&
    !useWorkflowStore.getState().pinData[options.destinationNode!]
  ) {
    await listenForTestEvent(deps, options.destinationNode!);
    return;
  }
  if (!options.destinationNode) {
    const listenOn = webhookTriggerToListen(deps);
    if (listenOn) {
      await listenForTestEvent(deps, listenOn);
      return;
    }
  }

  const id = await ensureSaved(deps, false);
  if (!id) return;
  const s = useWorkflowStore.getState();
  const ran = ranDefinitionOf(s);
  const last = useRunStore.getState();
  const lastRunData = last.workflowId === id && Object.keys(last.runData).length ? last.runData : undefined;
  // P3-06 partial run (n8n): an "Execute step" sends the last run data and the nodes changed since it was produced;
  // the nodes before the changed ones keep their output. "Execute workflow" (no destination) is a full run.
  let runData: RunData | undefined;
  let dirtyNodeNames: string[] | undefined;
  let reuse: RunData | undefined;
  if (options.destinationNode && lastRunData && last.ranDefinition) {
    dirtyNodeNames = Object.keys(dirtyNodesFromDiff(last.ranDefinition, ran, lastRunData));
    try {
      const plan = planPartialRun(ran, {
        root: stepRunRoot(deps, ran, options.destinationNode),
        destination: options.destinationNode,
        runData: lastRunData,
        pinData: s.pinData,
        dirtyNodeNames,
      });
      runData = lastRunData;
      reuse = plan.runData;
    } catch (error) {
      toast.error('Could not run this step', errorMessage(error));
      return;
    }
  } else if (options.startNode && lastRunData) {
    // a run from a start node gets its parents' output from the last run
    runData = lastRunData;
  }
  useRunStore.getState().beginRun(id, { ran, reuse });
  try {
    const { executionId } = await workflowsApi.run(id, {
      workflowData: s.dirty ? { ...toWorkflowBody(s), id } : undefined,
      destinationNode: options.destinationNode,
      startNode: options.startNode,
      pinData: s.pinData,
      ...(runData ? { runData } : {}),
      ...(runData && dirtyNodeNames ? { dirtyNodeNames } : {}),
    });
    useRunStore.getState().adopt(executionId);
  } catch (error) {
    const message = isApiError(error, 413) ? RUN_DATA_TOO_LARGE : errorMessage(error);
    useRunStore.getState().fail({ name: 'Error', message });
    toast.error('Could not start the run', message);
  }
}

let listenTimer: ReturnType<typeof setTimeout> | null = null;

export async function listenForTestEvent(deps: EditorDeps, nodeName: string): Promise<void> {
  const id = await ensureSaved(deps, true);
  if (!id) return;
  try {
    const { testUrl, expiresAt } = await workflowsApi.listenTestWebhook(id, nodeName);
    useRunStore
      .getState()
      .beginListening(id, { nodeName, testUrl, expiresAt }, ranDefinitionOf(useWorkflowStore.getState()));
    if (listenTimer) clearTimeout(listenTimer);
    const ms = Math.max(5_000, new Date(expiresAt).getTime() - Date.now());
    listenTimer = setTimeout(
      () => {
        if (useRunStore.getState().status === 'listening') {
          void stopListening();
          toast.info('Stopped listening', 'No test event arrived in time.');
        }
      },
      Number.isFinite(ms) ? ms : 120_000,
    );
  } catch (error) {
    toast.error('Could not listen for a test event', errorMessage(error));
  }
}

/** Stop listening here and drop the test registration on the server (if that fails it expires by itself). */
export async function stopListening(): Promise<void> {
  if (listenTimer) clearTimeout(listenTimer);
  const { workflowId, testWebhook } = useRunStore.getState();
  useRunStore.getState().stopListening();
  if (!workflowId || !testWebhook) return;
  try {
    await workflowsApi.stopListeningTestWebhook(workflowId, testWebhook.nodeName);
  } catch (error) {
    toast.error('Could not stop the test listener on the server', errorMessage(error));
  }
}

export async function stopExecution(): Promise<void> {
  const { executionId, status } = useRunStore.getState();
  if (status === 'listening') return stopListening();
  if (!executionId) return;
  try {
    await executionsApi.stop(executionId);
  } catch (error) {
    toast.error('Could not stop the execution', errorMessage(error));
  }
}

export function activationDetails(error: unknown): ActivationErrorDetail[] | null {
  if (!isApiError(error, 400)) return null;
  const details = error.details;
  if (Array.isArray(details) && details.every((d) => d && typeof d === 'object' && 'message' in d)) {
    return details as ActivationErrorDetail[];
  }
  return null;
}

export async function setWorkflowActive(deps: EditorDeps, active: boolean): Promise<boolean> {
  const id = await ensureSaved(deps, true);
  if (!id) return false;
  try {
    const dto = active ? await workflowsApi.activate(id) : await workflowsApi.deactivate(id);
    useWorkflowStore.getState().setActive(dto.active, dto.versionId);
    useUiStore.getState().setActivationErrors(null);
    toast.success(dto.active ? 'Workflow activated' : 'Workflow deactivated');
    return true;
  } catch (error) {
    const details = activationDetails(error);
    if (details) useUiStore.getState().setActivationErrors(details);
    else
      toast.error(
        active ? 'Could not activate the workflow' : 'Could not deactivate the workflow',
        errorMessage(error),
      );
    return false;
  }
}
