/**
 * P5-67 (L2): one Assistant event applied to the open thread's state. Pure: deltas append to the live segment
 * and `text-block` replaces it with a message, so a reconnect mid-block never shows text twice; a durable event
 * with an id at or below `cursor` changes nothing.
 *
 * An event that changes nothing returns the same state object, so a caller can tell a dropped replay apart.
 * `thread-title-updated` and `status` change no thread state (the store keeps the title in its thread list,
 * and progress text is live only).
 */
import type {
  AssistantArtifact,
  AssistantEvent,
  AssistantEventOf,
  AssistantMessageDTO,
  AssistantRunStatus,
} from '@workflow/workflow';
import type { AssistantPhase, AssistantThreadState, AssistantToolRun } from '../../stores/assistant-store';

/** the text a run that ended in an error shows when the server gave no reason */
export const ASSISTANT_RUN_FAILED = "Couldn't finish this reply. Try again.";
/** the error a tool row shows when its run ended before the tool answered */
export const ASSISTANT_TOOL_STOPPED = 'Stopped before it finished';

const PHASE_AFTER_FINISH: Record<AssistantRunStatus, AssistantPhase> = {
  completed: 'idle',
  suspended: 'suspended',
  cancelled: 'idle',
  error: 'idle',
};

/** one artifact's identity: the same workflow, table or draft is listed once */
export function artifactKey(artifact: AssistantArtifact): string {
  return artifact.type === 'draft' ? `draft:${artifact.draftId}` : `${artifact.type}:${artifact.id}`;
}

function upsertRun(
  runs: AssistantToolRun[],
  toolCallId: string,
  change: (run: AssistantToolRun | undefined) => AssistantToolRun,
): AssistantToolRun[] {
  const index = runs.findIndex((run) => run.toolCallId === toolCallId);
  if (index < 0) return [...runs, change(undefined)];
  const next = [...runs];
  next[index] = change(runs[index]);
  return next;
}

/** the assistant message a text block writes: a new one, or the stored one with the same id replaced */
function writeTextBlock(
  messages: AssistantMessageDTO[],
  event: AssistantEventOf<'text-block'>,
): AssistantMessageDTO[] {
  const { messageId, text } = event.payload;
  const index = messages.findIndex((message) => message.id === messageId);
  if (index >= 0) {
    const next = [...messages];
    next[index] = { ...messages[index], content: text };
    return next;
  }
  return [
    ...messages,
    {
      id: messageId,
      runId: event.runId,
      role: 'assistant',
      content: text,
      toolCalls: [],
      summarized: false,
      createdAt: '',
    },
  ];
}

/**
 * A tool call joins the last message when that is the same run's assistant message (the server saves the
 * message, then sends its text block and its calls), so the row shows under the text that asked for it.
 */
function attachCall(
  messages: AssistantMessageDTO[],
  event: AssistantEventOf<'tool-call'>,
): AssistantMessageDTO[] {
  const last = messages.at(-1);
  if (event.runId === null || last?.role !== 'assistant' || last.runId !== event.runId) return messages;
  const calls = last.toolCalls ?? [];
  if (calls.some((call) => call.id === event.payload.toolCallId)) return messages;
  const call = { id: event.payload.toolCallId, name: event.payload.toolName, args: event.payload.args };
  return [...messages.slice(0, -1), { ...last, toolCalls: [...calls, call] }];
}

/** rows still running when a turn ends for good: a suspended turn keeps the rows its open cards hold */
function settleRuns(state: AssistantThreadState, status: AssistantRunStatus): AssistantToolRun[] {
  if (status === 'suspended') return state.toolRuns;
  if (!state.toolRuns.some((run) => run.state === 'running')) return state.toolRuns;
  return state.toolRuns.map((run) =>
    run.state === 'running' ? { ...run, state: 'failed', error: run.error ?? ASSISTANT_TOOL_STOPPED } : run,
  );
}

function apply(state: AssistantThreadState, event: AssistantEvent): AssistantThreadState {
  switch (event.type) {
    case 'run-start':
      return { ...state, status: 'running', streamingText: '', error: null };
    case 'text-delta':
      if (!event.payload.text) return state;
      return { ...state, status: 'running', streamingText: state.streamingText + event.payload.text };
    case 'text-block':
      return { ...state, messages: writeTextBlock(state.messages, event), streamingText: '' };
    case 'tool-call': {
      const { toolCallId, toolName, args } = event.payload;
      return {
        ...state,
        messages: attachCall(state.messages, event),
        toolRuns: upsertRun(state.toolRuns, toolCallId, (run) => ({
          toolCallId,
          toolName,
          args: args ?? {},
          state: run?.state === 'done' || run?.state === 'failed' ? run.state : 'running',
          result: run?.result,
          error: run?.error,
        })),
      };
    }
    case 'tool-result': {
      const { toolCallId, toolName, result } = event.payload;
      return {
        ...state,
        toolRuns: upsertRun(state.toolRuns, toolCallId, (run) => ({
          toolCallId,
          toolName,
          args: run?.args ?? {},
          state: 'done',
          result,
        })),
      };
    }
    case 'tool-error': {
      const { toolCallId, toolName, error } = event.payload;
      return {
        ...state,
        toolRuns: upsertRun(state.toolRuns, toolCallId, (run) => ({
          toolCallId,
          toolName,
          args: run?.args ?? {},
          state: 'failed',
          error,
        })),
      };
    }
    case 'confirmation-request': {
      const { confirmation } = event.payload;
      const rest = state.pending.filter((card) => card.requestId !== confirmation.requestId);
      return { ...state, pending: [...rest, confirmation] };
    }
    case 'confirmation-resolved': {
      const pending = state.pending.filter((card) => card.requestId !== event.payload.requestId);
      return pending.length === state.pending.length ? state : { ...state, pending };
    }
    case 'tasks-update':
      return { ...state, tasks: event.payload.tasks };
    case 'artifact': {
      const key = artifactKey(event.payload.artifact);
      const index = state.artifacts.findIndex((artifact) => artifactKey(artifact) === key);
      if (index < 0) return { ...state, artifacts: [...state.artifacts, event.payload.artifact] };
      const artifacts = [...state.artifacts];
      artifacts[index] = event.payload.artifact;
      return { ...state, artifacts };
    }
    case 'error':
      return { ...state, error: event.payload.message };
    case 'run-finish': {
      const { status, reason } = event.payload;
      return {
        ...state,
        status: PHASE_AFTER_FINISH[status] ?? 'idle',
        streamingText: '',
        toolRuns: settleRuns(state, status),
        error: status === 'error' ? (reason ?? state.error ?? ASSISTANT_RUN_FAILED) : state.error,
      };
    }
    case 'thread-title-updated':
    case 'status':
      return state;
    default:
      return state;
  }
}

export function reduceAssistantEvent(
  state: AssistantThreadState,
  event: AssistantEvent,
): AssistantThreadState {
  const id = typeof event.id === 'number' && Number.isFinite(event.id) ? event.id : null;
  // a replayed durable event the state already holds
  if (id !== null && id <= state.cursor) return state;
  const next = apply(state, event);
  if (id === null) return next;
  return next === state ? { ...state, cursor: id } : { ...next, cursor: id };
}
