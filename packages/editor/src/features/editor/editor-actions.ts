/**
 * Workflow-level commands of the editor: save (with 409 handling), run, listen for a test
 * webhook, execute a single step, activate/deactivate. They read and write the stores directly
 * so they can be used from buttons, keyboard shortcuts and the NDV alike.
 */
import {
  CHAT_TRIGGER_TYPE,
  type Connections,
  type DataObject,
  dirtyNodesFromDiff,
  EVALUATION_TRIGGER_TYPE,
  type NodeTypeDescription,
  planPartialRun,
  type RunData,
  sortByPosition,
  toolNameOf,
} from '@workflow/workflow';
import { errorMessage, isApiError } from '../../api/client';
import { executionsApi, workflowsApi } from '../../api/endpoints';
import type { ActivationErrorDetail, WorkflowDTO, WorkflowPatchBody } from '../../api/types';
import { deriveNodePorts, isTriggerDescription } from '../../lib/ports';
import { getAncestors } from '../../lib/workflow-ops';
import { refuseWhileReviewing, useBuilderStore } from '../../stores/builder-store';
import { type RanDefinition, useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { toWorkflowBody, useWorkflowStore, type WorkflowState } from '../../stores/workflow-store';
import { onDraftAccepted } from '../builder/session-actions';
import { chatTriggerBelow, openChat } from './chat-actions';
import { openTestForm } from './form-popup';

export interface EditorDeps {
  navigate: (to: string, options?: { replace?: boolean }) => void;
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  onSaved?: (dto: WorkflowDTO) => void;
}

export interface SaveOptions {
  /** P3-17: the version this save creates is an autosave (useAutosave) */
  autosaved?: boolean;
  /**
   * A failed autosave raises no toast (D4): it reports the error here and useAutosave shows it in
   * the header status with the retry countdown. A manual save keeps its toast.
   */
  onError?: (message: string) => void;
  /**
   * P5-62: this save is the AI builder's Accept (or the conflict dialog's "Keep mine" during a review).
   * Without it, no save runs while a draft is under review (finding 2 of the S4 plan).
   */
  builderAccept?: boolean;
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
  // a draft under review is saved only by Accept: Save, Ctrl S, listen, publish and the canvas chat stop here
  if (!options.builderAccept && refuseWhileReviewing()) return null;
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
    if (options.autosaved) options.onError?.(errorMessage(error));
    else toast.error('Could not save the workflow', errorMessage(error));
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
    // their version replaces a builder draft: the review ends
    useBuilderStore.getState().clearReview();
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
    // during a review "Keep mine" accepts the draft, so the chat gets the saved version as Accept does
    const accepting = useBuilderStore.getState().reviewing;
    const saved = await saveWorkflow(deps, { builderAccept: accepting });
    if (saved) {
      useBuilderStore.getState().clearReview();
      if (accepting) await onDraftAccepted(saved.id, saved.versionId).catch(() => undefined);
      toast.success('Saved your version');
    }
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

/** triggers that make their data when asked, though nothing in their description says they do not listen */
const TRIGGERS_THAT_RUN_AT_ONCE = new Set([
  'core.manualTrigger',
  'core.errorTrigger',
  'core.executeWorkflowTrigger',
  // P5-02: Execute runs the first dataset row at once (no outside event to wait for)
  EVALUATION_TRIGGER_TYPE,
]);

/**
 * A trigger that waits for an event from outside and has no URL to call (Kafka, MQTT, IMAP, ...): it needs a
 * test listener. Pollers and schedules produce a sample at once, so they run as usual.
 */
export function isEventTrigger(description: NodeTypeDescription | undefined): boolean {
  if (!description || !isTriggerDescription(description)) return false;
  return (
    !description.webhooks?.length &&
    !description.polling &&
    !description.group.includes('schedule') &&
    !TRIGGERS_THAT_RUN_AT_ONCE.has(description.name)
  );
}

/** Trigger nodes that only start on an HTTP call or an outside event need "Listen for test event". */
export function webhookTriggerToListen(deps: EditorDeps): string | null {
  const s = useWorkflowStore.getState();
  const triggers = s.nodes.filter((n) => !n.disabled && isTriggerDescription(deps.descriptions.get(n.type)));
  if (!triggers.length) return null;
  const manual = triggers.find((n) => {
    const description = deps.descriptions.get(n.type);
    return !description?.webhooks?.length && !isEventTrigger(description);
  });
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

function toolConsumers(connections: Connections, name: string): string[] {
  return Object.entries(connections[name] ?? {})
    .filter(([type]) => type !== 'main')
    .flatMap(([, outputs]) => outputs ?? [])
    .flatMap((slot) => slot ?? [])
    .map((connection) => connection.node);
}

/** the node that calls a tool directly, for the prompt of the tool test; undefined when nothing calls it */
export function toolParentName(connections: Connections, tool: string): string | undefined {
  return toolConsumers(connections, tool)[0];
}

/** P5-76: as the engine's toolRootOf: along the non-main connections to the first node that is not a sub-node */
function toolRootName(deps: EditorDeps, def: RanDefinition, tool: string): string {
  const seen = new Set([tool]);
  const queue = [tool];
  let last = tool;
  for (const name of queue) {
    const node = def.nodes.find((n) => n.name === name);
    if (!node) continue;
    if (!deriveNodePorts(node, deps.descriptions.get(node.type)).isSubNode) return name;
    last = name;
    for (const consumer of toolConsumers(def.connections, name)) {
      if (seen.has(consumer)) continue;
      seen.add(consumer);
      queue.push(consumer);
    }
  }
  return last;
}

/** the values of the tool test that `runToolTest` is starting */
let startingToolTest: { nodeName: string; query: DataObject } | null = null;

/**
 * P5-76 Test a tool. `execute` is the caller's own "Execute step" for the node (it holds the editor's deps and names
 * only the node), so the values wait here for the moment it takes to reach `runWorkflow`, which reads them at once.
 */
export function runToolTest(nodeName: string, query: DataObject, execute: (nodeName: string) => void): void {
  startingToolTest = { nodeName, query };
  try {
    execute(nodeName);
  } finally {
    startingToolTest = null;
  }
}

export const RUN_DATA_TOO_LARGE =
  'The data of the last run is too large to send. Execute the workflow to run every node again.';

export async function runWorkflow(
  deps: EditorDeps,
  options: { destinationNode?: string; startNode?: string } = {},
): Promise<void> {
  const agentRequest =
    options.destinationNode && startingToolTest?.nodeName === options.destinationNode
      ? { query: startingToolTest.query, toolName: toolNameOf(options.destinationNode) }
      : undefined;
  const run = useRunStore.getState();
  if (run.status === 'starting' || run.status === 'running') return;
  const destination = options.destinationNode
    ? deps.descriptions.get(
        useWorkflowStore.getState().nodes.find((n) => n.name === options.destinationNode)?.type ?? '',
      )
    : undefined;
  // a webhook or event trigger cannot "run": it waits for a call or an event
  if (
    (isEventTrigger(destination) || (destination?.webhooks?.length && isTriggerDescription(destination))) &&
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

  // P5-59: a step run below a Chat Trigger that has no input or pin takes its input from the chat
  if (options.destinationNode && !agentRequest) {
    const wf = useWorkflowStore.getState();
    const chatRun = useRunStore.getState();
    const asked = chatTriggerBelow(wf.nodes, wf.connections, options.destinationNode, {
      pinData: wf.pinData,
      runData: chatRun.runData,
    });
    if (asked) {
      openChat(options.destinationNode);
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
  // a tool test stops at the tool's root: the tool itself is on no main path
  const planDestination =
    agentRequest && options.destinationNode
      ? toolRootName(deps, ran, options.destinationNode)
      : options.destinationNode;
  if (planDestination && lastRunData && last.ranDefinition) {
    dirtyNodeNames = Object.keys(dirtyNodesFromDiff(last.ranDefinition, ran, lastRunData));
    try {
      const plan = planPartialRun(ran, {
        root: stepRunRoot(deps, ran, planDestination),
        destination: planDestination,
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
      ...(agentRequest ? { agentRequest } : {}),
    });
    useRunStore.getState().adopt(executionId);
  } catch (error) {
    const message = isApiError(error, 413) ? RUN_DATA_TOO_LARGE : errorMessage(error);
    useRunStore.getState().fail({ name: 'Error', message });
    toast.error('Could not start the run', message);
  }
}

let listenTimer: ReturnType<typeof setTimeout> | null = null;
/** the newest listen call: the server closes a listener a newer call replaces, and that call fails */
let listenCall = 0;

function stopListeningAt(expiresAt: string): void {
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
}

export async function listenForTestEvent(deps: EditorDeps, nodeName: string): Promise<void> {
  const type = useWorkflowStore.getState().nodes.find((n) => n.name === nodeName)?.type;
  // P5-59: a Chat Trigger waits for a message typed in the chat, not for a call to its URL
  if (type === CHAT_TRIGGER_TYPE) {
    openChat(null);
    return;
  }
  if (isEventTrigger(deps.descriptions.get(type ?? ''))) return listenForTriggerEvent(deps, nodeName);
  const id = await ensureSaved(deps, true);
  if (!id) return;
  try {
    const { testUrl, expiresAt, formTestUrls } = await workflowsApi.listenTestWebhook(id, nodeName);
    useRunStore
      .getState()
      .beginListening(id, { nodeName, testUrl, expiresAt }, ranDefinitionOf(useWorkflowStore.getState()));
    const listened = useWorkflowStore.getState().nodes.find((n) => n.name === nodeName);
    if (listened?.type === 'core.formTrigger' && formTestUrls[0]) openTestForm(formTestUrls[0]);
    stopListeningAt(expiresAt);
  } catch (error) {
    toast.error('Could not listen for a test event', errorMessage(error));
  }
}

/**
 * A trigger without a URL: the server starts the node, and its first event starts the test run. That event
 * can arrive before the call answers (a retained message), so the editor is listening before it asks.
 */
async function listenForTriggerEvent(deps: EditorDeps, nodeName: string): Promise<void> {
  const id = await ensureSaved(deps, true);
  if (!id) return;
  if (listenTimer) clearTimeout(listenTimer);
  const call = ++listenCall;
  const run = useRunStore.getState();
  run.beginListening(id, { nodeName, expiresAt: '' }, ranDefinitionOf(useWorkflowStore.getState()));
  try {
    const { expiresAt } = await workflowsApi.listenTestTrigger(id, nodeName);
    const { status } = useRunStore.getState();
    if (status === 'listening') {
      run.setListenExpiry(expiresAt);
      stopListeningAt(expiresAt);
    } else if (status === 'idle') {
      // stopped while the call ran, which may have overtaken the stop on the server
      await workflowsApi.stopTestTrigger(id).catch(() => undefined);
    }
  } catch (error) {
    // stopped or replaced while the call ran: the failure is the stop itself
    if (call !== listenCall || useRunStore.getState().status !== 'listening') return;
    run.stopListening();
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
    if (testWebhook.testUrl) await workflowsApi.stopListeningTestWebhook(workflowId, testWebhook.nodeName);
    else await workflowsApi.stopTestTrigger(workflowId);
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

/**
 * Why an activate or publish failed: activation problems in their dialog, anything else in a toast. Both add
 * the reason the server keeps for triggers that are down, as n8n's activation message does.
 */
export async function reportActivationFailure(id: string, title: string, error: unknown): Promise<void> {
  const reason = await workflowsApi.activationError(id).catch(() => null);
  const details = activationDetails(error);
  const said = details ? details.map((d) => d.message).join(' ') : errorMessage(error);
  const down = reason && !said.includes(reason) ? `The triggers are down: ${reason}` : null;
  if (details) {
    useUiStore.getState().setActivationErrors(down ? [...details, { node: '', message: down }] : details);
  } else {
    toast.error(title, down ? `${said} ${down}` : said);
  }
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
    if (active) await reportActivationFailure(id, 'Could not activate the workflow', error);
    else toast.error('Could not deactivate the workflow', errorMessage(error));
    return false;
  }
}
