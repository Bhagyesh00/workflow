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
  AssistantAttachmentRef,
  AssistantConfirmation,
  AssistantEvent,
  AssistantMessageDTO,
  AssistantSendMessage,
  AssistantStatusDTO,
  AssistantTask,
  AssistantThreadDTO,
  DataObject,
} from '@workflow/workflow';
import { create } from 'zustand';
import { streamAssistantEvents } from '../api/assistant-stream';
import { errorMessage } from '../api/client';
import { assistantApi } from '../api/endpoints';
import type { AssistantDraftView, AssistantThreadPage } from '../api/types';
import { artifactKey, reduceAssistantEvent } from '../features/assistant/event-reducer';
import { newId } from '../lib/ids';

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
  /** the highest durable event id seen; the stream resumes after it */
  cursor: number;
  /** the cursor the thread was loaded at (set by the first event): an id at or below it is in `messages` */
  floor?: number;
  /** the last durable ids applied (bounded): a replay of one changes nothing, an older id not among them applies */
  delivered?: number[];
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
    floor: undefined,
    delivered: undefined,
    error: null,
  };
}

/** the open thread's part of the state, empty */
function emptyThread(): AssistantThreadState {
  const {
    messages,
    streamingText,
    toolRuns,
    pending,
    tasks,
    artifacts,
    status,
    cursor,
    floor,
    delivered,
    error,
  } = initialAssistantState();
  return {
    messages,
    streamingText,
    toolRuns,
    pending,
    tasks,
    artifacts,
    status,
    cursor,
    floor,
    delivered,
    error,
  };
}

/** the running stream of the open thread; one at a time */
let stream: AbortController | null = null;
/** bumped by every open, reload, close and reset, so a late answer of an older load changes nothing */
let generation = 0;

function endStream(): void {
  stream?.abort();
  stream = null;
}

function phaseOf(status: AssistantStatusDTO): AssistantPhase {
  if (status.hasActiveRun) return 'running';
  if (status.isSuspended || status.pending.length > 0) return 'suspended';
  return 'idle';
}

/** the attachments of a sent message as the thread shows them (names and sizes, never the bytes) */
function attachmentRefs(body: AssistantSendMessage): AssistantAttachmentRef[] | undefined {
  if (!body.attachments?.length) return undefined;
  return body.attachments.map((file) => ({
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: Math.floor((file.data.length * 3) / 4),
  }));
}

/** the thread list answer: the editor's page shape, or a bare list */
function threadsOf(
  page: AssistantThreadPage | AssistantThreadDTO[] | null | undefined,
): AssistantThreadDTO[] {
  if (Array.isArray(page)) return page;
  return Array.isArray(page?.data) ? page.data : [];
}

/** opens the stream of `threadId` after `afterId`; events of an older generation are dropped */
function startStream(threadId: string, afterId: number, token: number): void {
  endStream();
  const controller = new AbortController();
  stream = controller;
  const live = () => !controller.signal.aborted && token === generation;
  streamAssistantEvents(
    threadId,
    afterId,
    (event) => {
      if (live()) useAssistantStore.getState().applyEvent(event);
    },
    controller.signal,
  ).catch((error: unknown) => {
    if (live()) useAssistantStore.setState({ error: errorMessage(error) });
  });
}

/** the artifacts the loaded messages carry, one per id; a later one replaces the earlier and moves last */
function artifactsOf(messages: AssistantMessageDTO[]): AssistantArtifact[] {
  const byKey = new Map<string, AssistantArtifact>();
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      const key = artifactKey(artifact);
      byKey.delete(key);
      byKey.set(key, artifact);
    }
  }
  return [...byKey.values()];
}

/** messages, then status, then the stream from `nextEventId - 1` (n8n's open order) */
async function loadThread(threadId: string, token: number): Promise<void> {
  try {
    const page = await assistantApi.messages(threadId);
    if (token !== generation) return;
    const status = await assistantApi.status(threadId);
    if (token !== generation) return;
    const cursor = Math.max(0, (Number(page.nextEventId) || 1) - 1);
    const messages = page.messages ?? [];
    useAssistantStore.setState({
      messages,
      // the checklist and the artifacts column as the last stored events left them; live events update them
      tasks: [...messages].reverse().find((message) => message.tasks)?.tasks ?? [],
      artifacts: artifactsOf(messages),
      pending: status.pending ?? [],
      status: phaseOf({ ...status, pending: status.pending ?? [] }),
      streamingText: '',
      cursor,
      floor: undefined,
      delivered: undefined,
      error: null,
    });
    startStream(threadId, cursor, token);
  } catch (error) {
    if (token !== generation) return;
    useAssistantStore.setState({ status: 'idle', error: errorMessage(error) });
  }
}

/** Loads the caller's threads (newest first) into the store. */
export async function refreshAssistantThreads(): Promise<AssistantThreadDTO[]> {
  const threads = threadsOf(await assistantApi.threads({ limit: 100 }));
  useAssistantStore.getState().setThreads(threads);
  return threads;
}

/** Creates an empty thread and lists it first. */
export async function createAssistantThread(): Promise<AssistantThreadDTO> {
  const thread = await assistantApi.createThread({});
  useAssistantStore.setState((state) => ({
    threads: [thread, ...state.threads.filter((t) => t.id !== thread.id)],
  }));
  return thread;
}

/** Renames a thread; the list shows the server's title. */
export async function renameAssistantThread(threadId: string, title: string): Promise<void> {
  const thread = await assistantApi.renameThread(threadId, title);
  useAssistantStore.setState((state) => ({
    threads: state.threads.map((t) => (t.id === threadId ? { ...t, ...thread } : t)),
  }));
}

/** Deletes a thread (the server ends its run first); the open thread closes when it is the one deleted. */
export async function deleteAssistantThread(threadId: string): Promise<void> {
  await assistantApi.deleteThread(threadId);
  useAssistantStore.setState((state) => ({ threads: state.threads.filter((t) => t.id !== threadId) }));
  if (useAssistantStore.getState().activeThreadId === threadId) {
    await useAssistantStore.getState().openThread(null);
  }
}

export const useAssistantStore = create<AssistantState>()((set, get) => ({
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
  reset: () => {
    endStream();
    generation += 1;
    set(initialAssistantState());
  },

  openThread: async (threadId) => {
    endStream();
    generation += 1;
    const token = generation;
    if (!threadId) {
      set({ ...emptyThread(), activeThreadId: null, drafts: {} });
      return;
    }
    set({ ...emptyThread(), activeThreadId: threadId, drafts: {}, status: 'loading' });
    await loadThread(threadId, token);
  },

  send: async (body) => {
    let threadId = get().activeThreadId;
    if (!threadId) {
      // the first message of a new chat: the thread is made, opened and streamed before the turn starts
      const thread = await createAssistantThread();
      threadId = thread.id;
      endStream();
      generation += 1;
      set({ ...emptyThread(), activeThreadId: threadId, drafts: {} });
      startStream(threadId, 0, generation);
    }
    const local: AssistantMessageDTO = {
      id: `local-${newId()}`,
      runId: null,
      role: 'user',
      content: body.message,
      attachments: attachmentRefs(body),
      summarized: false,
      createdAt: new Date().toISOString(),
    };
    const before = get().status;
    const sentOn = threadId;
    set((state) => ({
      messages: [...state.messages, local],
      status: 'running',
      error: null,
      threads: [
        ...state.threads.filter((t) => t.id === sentOn),
        ...state.threads.filter((t) => t.id !== sentOn),
      ],
    }));
    try {
      await assistantApi.chat(sentOn, body);
    } catch (error) {
      if (get().activeThreadId === sentOn) {
        set((state) => ({
          messages: state.messages.filter((message) => message.id !== local.id),
          status: state.status === 'running' ? (before === 'loading' ? 'idle' : before) : state.status,
        }));
      }
      // the caller (the composer) shows why and gives the text back
      throw error;
    }
  },

  stop: async () => {
    const threadId = get().activeThreadId;
    if (!threadId) return;
    try {
      await assistantApi.cancel(threadId);
      // the stream's `run-finish` says `cancelled`; the composer is free again at once
      if (get().activeThreadId === threadId && get().status === 'running') {
        set({ status: 'idle', streamingText: '' });
      }
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  applyEvent: (event) =>
    set((state) => {
      // a replay the state already holds comes back as the same state (the reducer's delivered ids)
      const next = reduceAssistantEvent(state, event);
      if (event.type !== 'thread-title-updated') return next === state ? state : next;
      const title = event.payload.title;
      return {
        ...next,
        threads: state.threads.map((t) => (t.id === state.activeThreadId ? { ...t, title } : t)),
      };
    }),

  reload: async () => {
    const threadId = get().activeThreadId;
    if (!threadId) return;
    endStream();
    generation += 1;
    await loadThread(threadId, generation);
  },
}));
