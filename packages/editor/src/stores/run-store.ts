/**
 * Live state of the execution shown in the editor: run data per node, which nodes are running,
 * console output and the final status. Push events are folded in by the pure `reduceRunEvent`.
 */
import type {
  ExecutionErrorShape,
  ExecutionStatus,
  RunData,
  TaskData,
  WorkflowDefinition,
} from '@workflow/workflow';
import { create } from 'zustand';
import type { ExecutionDetail, PushEvent } from '../api/types';
import { maybeOpenFormPopup } from '../features/editor/form-popup';

export type RunStatus = 'idle' | 'starting' | 'listening' | ExecutionStatus;

export interface LogEntry {
  id: number;
  executionId: string;
  nodeName: string;
  args: unknown[];
  timestamp: number;
}

export interface TestWebhookState {
  nodeName: string;
  testUrl: string;
  expiresAt: string;
}

/** P3-06: the graph that produced `runData` (dirty nodes are found by diffing it with the canvas) */
export type RanDefinition = Pick<WorkflowDefinition, 'name' | 'nodes' | 'connections' | 'pinData'>;

export interface RunSnapshot {
  executionId: string | null;
  workflowId: string | null;
  status: RunStatus;
  runData: RunData;
  /** P3-06: the definition the run data came from; null when unknown */
  ranDefinition: RanDefinition | null;
  /** run data of the previous run, for "compare with previous run" */
  previousRunData: RunData | null;
  runningNodes: string[];
  logs: LogEntry[];
  error: ExecutionErrorShape | null;
  startedAt: number | null;
  finishedAt: number | null;
  testWebhook: TestWebhookState | null;
  /** events for executions not adopted yet (the run request may resolve after the first events) */
  pending: Record<string, PushEvent[]>;
  /** production executions seen while waiting, whose later events must not be buffered */
  ignored: string[];
}

export const MAX_LOG_ENTRIES = 1000;
const MAX_PENDING_EVENTS = 500;
const MAX_IGNORED_EXECUTIONS = 200;
let logSeq = 0;

export const initialRunSnapshot = (): RunSnapshot => ({
  executionId: null,
  workflowId: null,
  status: 'idle',
  runData: {},
  ranDefinition: null,
  previousRunData: null,
  runningNodes: [],
  logs: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  testWebhook: null,
  pending: {},
  ignored: [],
});

function eventExecutionId(event: PushEvent): string | undefined {
  return (event.data as { executionId?: string }).executionId;
}

/** Apply an event that belongs to the adopted execution. */
function applyOwnEvent(state: RunSnapshot, event: PushEvent): RunSnapshot {
  switch (event.type) {
    case 'executionStarted':
      return { ...state, status: 'running', startedAt: state.startedAt ?? Date.now() };
    case 'nodeExecuteBefore':
      return {
        ...state,
        status: state.status === 'starting' ? 'running' : state.status,
        runningNodes: state.runningNodes.includes(event.data.nodeName)
          ? state.runningNodes
          : [...state.runningNodes, event.data.nodeName],
      };
    case 'nodeExecuteAfter': {
      const { nodeName, runIndex, taskData } = event.data;
      const runs: TaskData[] = [...(state.runData[nodeName] ?? [])];
      runs[Math.max(0, runIndex ?? runs.length)] = taskData;
      return {
        ...state,
        runData: { ...state.runData, [nodeName]: runs.filter(Boolean) },
        runningNodes: state.runningNodes.filter((n) => n !== nodeName),
      };
    }
    case 'executionFinished':
      return {
        ...state,
        status: event.data.status,
        error: event.data.error ?? null,
        runningNodes: [],
        finishedAt: Date.now(),
      };
    case 'consoleMessage': {
      const entry: LogEntry = {
        id: ++logSeq,
        executionId: event.data.executionId,
        nodeName: event.data.nodeName,
        args: Array.isArray(event.data.args) ? event.data.args : [event.data.args],
        timestamp: Date.now(),
      };
      return { ...state, logs: [...state.logs, entry].slice(-MAX_LOG_ENTRIES) };
    }
    default:
      return state;
  }
}

/** Start following `executionId` and replay events that arrived before we knew it. */
export function adoptExecution(state: RunSnapshot, executionId: string): RunSnapshot {
  let next: RunSnapshot = {
    ...state,
    executionId,
    status: state.status === 'starting' || state.status === 'listening' ? 'running' : state.status,
    testWebhook: null,
    pending: {},
    ignored: [],
  };
  for (const event of state.pending[executionId] ?? []) next = applyOwnEvent(next, event);
  return next;
}

/**
 * Fold one push event into the run state. `openWorkflowId` is the workflow in the editor; events
 * for other executions are ignored, except that a starting editor adopts the manual execution
 * announced for its workflow and a listening editor adopts the one a test webhook call started.
 */
export function reduceRunEvent(
  state: RunSnapshot,
  event: PushEvent,
  openWorkflowId: string | null,
): RunSnapshot {
  if (event.type === 'ping') return state;
  const waiting = state.status === 'starting' || state.status === 'listening';

  if (event.type === 'testWebhookReceived') {
    if (event.data.workflowId !== openWorkflowId || state.status !== 'listening') return state;
    return adoptExecution(state, event.data.executionId);
  }
  if (event.type === 'executionStarted' && event.data.executionId !== state.executionId) {
    if (waiting && event.data.mode !== 'manual') return ignoreExecution(state, event.data.executionId);
    // a manual run request adopts its own execution; a listening editor waits for testWebhookReceived
    if (state.status === 'starting' && event.data.workflowId === openWorkflowId && !state.executionId) {
      return applyOwnEvent(adoptExecution(state, event.data.executionId), event);
    }
    return bufferEvent(state, event);
  }

  const executionId = eventExecutionId(event);
  if (!executionId) return state;
  if (executionId === state.executionId) return applyOwnEvent(state, event);
  if (waiting) return state.ignored.includes(executionId) ? state : bufferEvent(state, event);
  return state;
}

/** Forget an execution the editor must not follow (a production run): drop its buffer and skip its later events. */
function ignoreExecution(state: RunSnapshot, executionId: string): RunSnapshot {
  if (state.ignored.includes(executionId)) return state;
  const { [executionId]: _dropped, ...pending } = state.pending;
  return { ...state, pending, ignored: [...state.ignored, executionId].slice(-MAX_IGNORED_EXECUTIONS) };
}

function bufferEvent(state: RunSnapshot, event: PushEvent): RunSnapshot {
  const id = eventExecutionId(event);
  if (!id || (state.status !== 'starting' && state.status !== 'listening')) return state;
  const total = Object.values(state.pending).reduce((n, list) => n + list.length, 0);
  if (total >= MAX_PENDING_EVENTS) return state;
  return { ...state, pending: { ...state.pending, [id]: [...(state.pending[id] ?? []), event] } };
}

/** P4-02: a finished node may send the tester to the next form page. Outside the pure reducer. */
function openFormPopups(events: PushEvent[]): void {
  for (const event of events) if (event.type === 'nodeExecuteAfter') maybeOpenFormPopup(event.data.taskData);
}

export type NodeRunStatus = 'running' | 'success' | 'error' | 'waiting' | undefined;

export function nodeRunStatus(
  state: Pick<RunSnapshot, 'runData' | 'runningNodes'>,
  nodeName: string,
): NodeRunStatus {
  if (state.runningNodes.includes(nodeName)) return 'running';
  const runs = state.runData[nodeName];
  if (!runs?.length) return undefined;
  const last = runs[runs.length - 1];
  if (last.error || last.executionStatus === 'error') return 'error';
  if (last.executionStatus === 'waiting') return 'waiting';
  return 'success';
}

export interface RunState extends RunSnapshot {
  /**
   * clears previous results and waits for the execution started by a run request. P3-06: `ran` is the graph the
   * run uses; a partial run passes the run data it reuses (`reuse`), so those nodes keep their output on screen.
   */
  beginRun(workflowId: string | null, options?: { ran?: RanDefinition; reuse?: RunData }): void;
  beginListening(workflowId: string, webhook: TestWebhookState, ran?: RanDefinition): void;
  adopt(executionId: string): void;
  receive(event: PushEvent, openWorkflowId: string | null): void;
  fail(error: ExecutionErrorShape): void;
  stopListening(): void;
  loadExecution(detail: ExecutionDetail): void;
  clearLogs(): void;
  reset(): void;
}

export const useRunStore = create<RunState>()((set, get) => ({
  ...initialRunSnapshot(),

  beginRun(workflowId, options = {}) {
    const s = get();
    set({
      ...initialRunSnapshot(),
      workflowId,
      status: 'starting',
      runData: options.reuse ? { ...options.reuse } : {},
      ranDefinition: options.ran ?? null,
      previousRunData: Object.keys(s.runData).length ? s.runData : s.previousRunData,
      logs: s.logs,
      startedAt: Date.now(),
    });
  },
  beginListening(workflowId, webhook, ran) {
    const s = get();
    set({
      ...initialRunSnapshot(),
      workflowId,
      status: 'listening',
      ranDefinition: ran ?? null,
      testWebhook: webhook,
      previousRunData: Object.keys(s.runData).length ? s.runData : s.previousRunData,
      logs: s.logs,
    });
  },
  adopt(executionId) {
    const s = get();
    set(adoptExecution(s, executionId));
    openFormPopups(s.pending[executionId] ?? []);
  },
  receive(event, openWorkflowId) {
    const s = get();
    const next = reduceRunEvent(s, event, openWorkflowId);
    if (next !== s) set(next);
    // the events this run took in: those buffered until it was adopted, then this one
    if (next.executionId && next.executionId !== s.executionId)
      openFormPopups(s.pending[next.executionId] ?? []);
    if (next.executionId && eventExecutionId(event) === next.executionId) openFormPopups([event]);
  },
  fail(error) {
    set({ status: 'error', error, runningNodes: [], finishedAt: Date.now(), testWebhook: null });
  },
  stopListening() {
    set({ status: 'idle', testWebhook: null, pending: {}, ignored: [] });
  },
  loadExecution(detail) {
    set({
      ...initialRunSnapshot(),
      executionId: detail.id,
      workflowId: detail.workflowId,
      status: detail.status,
      runData: detail.state?.resultData?.runData ?? {},
      ranDefinition: detail.workflowData
        ? {
            name: detail.workflowData.name,
            nodes: detail.workflowData.nodes ?? [],
            connections: detail.workflowData.connections ?? {},
            pinData: detail.workflowData.pinData,
          }
        : null,
      error: detail.state?.resultData?.error ?? null,
      startedAt: detail.startedAt ? new Date(detail.startedAt).getTime() : null,
      finishedAt: detail.stoppedAt ? new Date(detail.stoppedAt).getTime() : null,
    });
  },
  clearLogs() {
    set({ logs: [] });
  },
  reset() {
    set(initialRunSnapshot());
  },
}));
