/**
 * State of the Assistant page (P5-67): the caller's threads, the open thread's messages, the live text of the
 * running turn, its tool rows, the cards waiting for a person, the task list, artifacts and drafts.
 *
 * The state, its setters and `reset` are C0's (FULL). The actions (`openThread` ... `reload`) are L2's: open
 * order as n8n (messages, status, then the stream from `nextEventId - 1`), `applyEvent` through
 * features/assistant/event-reducer.ts, `send` and `stop` through `assistantApi`. The stream's abort controller
 * lives here, so `reset` and `openThread` end a running stream.
 */
import type {
  AssistantArtifact,
  AssistantConfirmation,
  AssistantEvent,
  AssistantMessageDTO,
  AssistantSendMessage,
  AssistantTask,
  AssistantThreadDTO,
  DataObject,
} from '@workflow/workflow';
import { create } from 'zustand';
import type { AssistantDraftView } from '../api/types';

/** where the open thread is: nothing open, loading it, a turn running, or a turn waiting for a card */
export type AssistantPhase = 'idle' | 'loading' | 'running' | 'suspended';

/** one tool call of the open thread as the tool rows show it (name, running, done, failed, details) */
export interface AssistantToolRun {
  toolCallId: string;
  toolName: string;
  args: DataObject;
  state: 'running' | 'done' | 'failed';
  /** what the model saw (`tool-result`) */
  result?: string;
  /** `tool-error` */
  error?: string;
}

/** the part of the state an event changes (features/assistant/event-reducer.ts, pure) */
export interface AssistantThreadState {
  messages: AssistantMessageDTO[];
  /** the live text segment of the running turn: `text-delta` appends, `text-block` replaces it with a message */
  streamingText: string;
  /** in call order */
  toolRuns: AssistantToolRun[];
  /** cards waiting for a person */
  pending: AssistantConfirmation[];
  tasks: AssistantTask[];
  artifacts: AssistantArtifact[];
  status: AssistantPhase;
  /** the highest durable event id seen; the stream resumes after it, and a lower id is dropped */
  cursor: number;
  error: string | null;
}

export interface AssistantStoreData extends AssistantThreadState {
  threads: AssistantThreadDTO[];
  activeThreadId: string | null;
  /** loaded drafts by draft id */
  drafts: Record<string, AssistantDraftView>;
}

export interface AssistantState extends AssistantStoreData {
  setThreads: (threads: AssistantThreadDTO[]) => void;
  setActiveThreadId: (threadId: string | null) => void;
  setMessages: (messages: AssistantMessageDTO[]) => void;
  setStreamingText: (text: string) => void;
  setToolRuns: (toolRuns: AssistantToolRun[]) => void;
  setPending: (pending: AssistantConfirmation[]) => void;
  setTasks: (tasks: AssistantTask[]) => void;
  setArtifacts: (artifacts: AssistantArtifact[]) => void;
  setDrafts: (drafts: Record<string, AssistantDraftView>) => void;
  /** adds or replaces one loaded draft */
  putDraft: (draftId: string, draft: AssistantDraftView) => void;
  setStatus: (status: AssistantPhase) => void;
  setCursor: (cursor: number) => void;
  setError: (error: string | null) => void;
  /** back to the empty state (keeps nothing, ends a running stream once L2 holds one) */
  reset: () => void;

  /** L2: loads a thread (messages, status, then the stream); null closes the open one */
  openThread: (threadId: string | null) => Promise<void>;
  /** L2: sends a message on the open thread and starts its turn */
  send: (body: AssistantSendMessage) => Promise<void>;
  /** L2: cancels the running turn */
  stop: () => Promise<void>;
  /** L2: one event of the open thread's stream, through the pure reducer */
  applyEvent: (event: AssistantEvent) => void;
  /** L2: loads the open thread again (messages and status), as after a reconnect */
  reload: () => Promise<void>;
}

/** the empty state; a fresh object each call so no two resets share arrays */
export function initialAssistantState(): AssistantStoreData {
  return {
    threads: [],
    activeThreadId: null,
    messages: [],
    streamingText: '',
    toolRuns: [],
    pending: [],
    tasks: [],
    artifacts: [],
    drafts: {},
    status: 'idle',
    cursor: 0,
    error: null,
  };
}

export const useAssistantStore = create<AssistantState>()((set) => ({
  ...initialAssistantState(),

  setThreads: (threads) => set({ threads }),
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
  setMessages: (messages) => set({ messages }),
  setStreamingText: (streamingText) => set({ streamingText }),
  setToolRuns: (toolRuns) => set({ toolRuns }),
  setPending: (pending) => set({ pending }),
  setTasks: (tasks) => set({ tasks }),
  setArtifacts: (artifacts) => set({ artifacts }),
  setDrafts: (drafts) => set({ drafts }),
  putDraft: (draftId, draft) => set((state) => ({ drafts: { ...state.drafts, [draftId]: draft } })),
  setStatus: (status) => set({ status }),
  setCursor: (cursor) => set({ cursor }),
  setError: (error) => set({ error }),
  reset: () => set(initialAssistantState()),

  openThread: async (_threadId) => {
    throw new Error('not implemented (L2)');
  },
  send: async (_body) => {
    throw new Error('not implemented (L2)');
  },
  stop: async () => {
    throw new Error('not implemented (L2)');
  },
  applyEvent: (_event) => {
    throw new Error('not implemented (L2)');
  },
  reload: async () => {
    throw new Error('not implemented (L2)');
  },
}));
