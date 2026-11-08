/**
 * State of the AI workflow builder (P5-09, P5-62): the chat, the stream of the running turn and the
 * draft under review. While `reviewing` is true the canvas holds the builder's draft, which only
 * Accept saves: every save path refuses with `BUILDER_REVIEW_BLOCKED` (editor-actions.ts `doSave`,
 * autosave, duplicate, convert to sub-workflow). `clearReview` ends a review and any running stream;
 * `reset` also clears the chat, so another workflow never sees this one's stream or draft.
 *
 * The actions (`send` ... `loadHistory`) are what L3, L4, L5 and L6 call. A turn: the first send on a new
 * canvas saves the row once; the request carries the canvas as `workflowData`; the first `workflow-updated`
 * takes the snapshot and starts the review (before the canvas changes, so autosave never sees the draft);
 * the turn's `abortController` lives here, so `stop`, `clearReview` and `reset` end the stream.
 */
import {
  BUILDER_PROMPT_LIMIT,
  BUILDER_PROMPT_TOO_LONG,
  type BuilderChunk,
  type BuilderMessage,
  type BuilderMode,
  type BuilderPlan,
  type BuilderQuestion,
  type BuilderResume,
  type BuildRequest,
} from '@workflow/workflow';
import type { ReactFlowInstance } from '@xyflow/react';
import { create } from 'zustand';
import { streamBuild } from '../api/ai-stream';
import { errorMessage } from '../api/client';
import { aiApi, credentialsApi } from '../api/endpoints';
import type { CredentialSummary } from '../api/types';
import { acceptBuilderDraft } from '../features/builder/accept-draft';
import { applyBuilderChunk, setBuilderCredentials } from '../features/builder/apply-chunk';
import { notifyBuilderDone } from '../features/builder/notify';
import { type EditorDeps, runWorkflow, saveWorkflow } from '../features/editor/editor-actions';
import { newId } from '../lib/ids';
import type { WorkflowGraph } from '../lib/workflow-ops';
import { toast, useUiStore } from './ui-store';
import { graphOf, toWorkflowBody, useWorkflowStore } from './workflow-store';

/** the toast every save path shows while a draft is under review */
export const BUILDER_REVIEW_BLOCKED = 'Accept or discard the draft first';

/** the canvas before the builder's first change: Discard loads it back, Accept saves on its version */
export interface WorkflowSnapshot {
  graph: WorkflowGraph;
  /** the saved version the draft is based on (Accept saves with it, so a newer save gives 409) */
  versionId: string | undefined;
  /** whether the canvas had unsaved changes before the draft */
  dirty: boolean;
}

/** one progress row of the running turn (a `tool` chunk) */
export interface BuilderProgress {
  toolName: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
}

/** the error a turn ended with (an `error` chunk, or a failed request) */
export interface BuilderError {
  title: string;
  message: string;
}

/** a page the model asked to read; the user approves or denies it (P5-64) */
export interface BuilderWebFetchRequest {
  url: string;
  domain: string;
}

/**
 * What the builder's actions need from the editor page. The page sets it on mount
 * (`setDeps`) and clears it on unmount; `reset` keeps it, since it is wiring, not chat state.
 */
export interface BuilderDeps extends EditorDeps {
  /** the canvas instance, for the tidy-up after a `workflow-updated` chunk */
  flow?: ReactFlowInstance;
}

export interface BuilderSendOptions {
  /** the answer to questions, a plan decision or a web fetch decision (P5-63, P5-64) */
  resumeData?: BuilderResume;
}

/** the data of the store (no functions) */
export interface BuilderStateData {
  /** the panel is open (kept in sync with `ui.sidePanel === 'builder'` by `setOpen`) */
  open: boolean;
  /** a turn is streaming; the canvas is read only meanwhile */
  streaming: boolean;
  /** the canvas holds an unaccepted draft */
  reviewing: boolean;
  snapshot: WorkflowSnapshot | null;
  messages: BuilderMessage[];
  progress: BuilderProgress[];
  questions: BuilderQuestion[] | null;
  plan: BuilderPlan | null;
  pendingWebFetch: BuilderWebFetchRequest | null;
  mode: BuilderMode;
  error: BuilderError | null;
  /** aborts the running turn's request; `clearReview` and `reset` call it */
  abortController: AbortController | null;
  deps: BuilderDeps | null;
}

export interface BuilderState extends BuilderStateData {
  // setters (C0, full)
  setOpen(open: boolean): void;
  setStreaming(streaming: boolean): void;
  setReviewing(reviewing: boolean): void;
  setSnapshot(snapshot: WorkflowSnapshot | null): void;
  setMessages(messages: BuilderMessage[]): void;
  addMessage(message: BuilderMessage): void;
  setProgress(progress: BuilderProgress[]): void;
  setQuestions(questions: BuilderQuestion[] | null): void;
  setPlan(plan: BuilderPlan | null): void;
  setPendingWebFetch(request: BuilderWebFetchRequest | null): void;
  setMode(mode: BuilderMode): void;
  setError(error: BuilderError | null): void;
  setAbortController(controller: AbortController | null): void;
  setDeps(deps: BuilderDeps | null): void;
  /** aborts a running stream and ends the review: `reviewing` false, `snapshot` null (C0, full) */
  clearReview(): void;
  /** `clearReview`, then the initial state; `deps` stays (C0, full) */
  reset(): void;

  // actions (L2)
  /** sends a message (or a resume) and streams the turn into the store and the canvas */
  send(text: string, options?: BuilderSendOptions): Promise<void>;
  /** stops the running turn; the draft so far stays under review */
  stop(): void;
  /** applies one chunk of the stream (features/builder/apply-chunk.ts does the canvas part) */
  applyChunk(chunk: BuilderChunk): void;
  /** saves the draft (`saveWorkflow(deps, { builderAccept: true })`); true when saved */
  acceptDraft(): Promise<boolean>;
  /** loads the snapshot back; nothing is sent */
  discardDraft(): void;
  /** runs the draft as it is on the canvas (`runWorkflow`, sends `workflowData`, saves nothing) */
  runDraft(): Promise<void>;
  /** the chat of this workflow for this user (`aiApi.sessions`) */
  loadHistory(workflowId: string): Promise<void>;
}

/** the state `reset` returns to (without `deps`) */
export const builderInitialState = (): Omit<BuilderStateData, 'deps'> => ({
  open: false,
  streaming: false,
  reviewing: false,
  snapshot: null,
  messages: [],
  progress: [],
  questions: null,
  plan: null,
  pendingWebFetch: null,
  mode: 'build',
  error: null,
  abortController: null,
});

/** title of a turn that failed before or outside the stream (a failed request, not an `error` chunk) */
export const BUILDER_REQUEST_FAILED = "Couldn't build the workflow";
/** title of a chat history that did not load */
export const BUILDER_HISTORY_FAILED = "Couldn't load the chat";

const isAbort = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === 'AbortError';

/** the user's credentials for the client-side assignment; none when they cannot be read */
async function loadCredentials(): Promise<CredentialSummary[]> {
  try {
    return await credentialsApi.list();
  } catch {
    return [];
  }
}

/** a `tool` chunk on the progress rows: it updates the running row of that tool, else it is a new row */
function withProgress(
  rows: BuilderProgress[],
  chunk: Extract<BuilderChunk, { type: 'tool' }>,
): BuilderProgress[] {
  const row: BuilderProgress = {
    toolName: chunk.toolName,
    status: chunk.status,
    ...(chunk.summary ? { summary: chunk.summary } : {}),
  };
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].toolName === chunk.toolName && rows[i].status === 'running') {
      return rows.map((r, at) => (at === i ? { ...r, ...row } : r));
    }
  }
  return [...rows, row];
}

/** a `message` chunk on the chat: a delta adds to its message, a whole text replaces it */
function withMessage(
  messages: BuilderMessage[],
  chunk: Extract<BuilderChunk, { type: 'message' }>,
): BuilderMessage[] {
  const at = messages.findIndex((m) => m.id === chunk.id);
  if (at < 0) {
    return [
      ...messages,
      { id: chunk.id, role: 'assistant', text: chunk.text, createdAt: new Date().toISOString() },
    ];
  }
  return messages.map((m, i) =>
    i === at ? { ...m, text: chunk.delta ? m.text + chunk.text : chunk.text } : m,
  );
}

export const useBuilderStore = create<BuilderState>()((set, get) => ({
  ...builderInitialState(),
  deps: null,

  setOpen(open) {
    set({ open });
    const ui = useUiStore.getState();
    if (open && ui.sidePanel !== 'builder') ui.setSidePanel('builder');
    if (!open && ui.sidePanel === 'builder') ui.setSidePanel(null);
  },
  setStreaming(streaming) {
    set({ streaming });
  },
  setReviewing(reviewing) {
    set({ reviewing });
  },
  setSnapshot(snapshot) {
    set({ snapshot });
  },
  setMessages(messages) {
    set({ messages });
  },
  addMessage(message) {
    set((s) => ({ messages: [...s.messages, message] }));
  },
  setProgress(progress) {
    set({ progress });
  },
  setQuestions(questions) {
    set({ questions });
  },
  setPlan(plan) {
    set({ plan });
  },
  setPendingWebFetch(pendingWebFetch) {
    set({ pendingWebFetch });
  },
  setMode(mode) {
    set({ mode });
  },
  setError(error) {
    set({ error });
  },
  setAbortController(abortController) {
    set({ abortController });
  },
  setDeps(deps) {
    set({ deps });
  },
  clearReview() {
    const controller = get().abortController;
    if (controller && !controller.signal.aborted) controller.abort();
    set({ abortController: null, streaming: false, reviewing: false, snapshot: null });
  },
  reset() {
    get().clearReview();
    set(builderInitialState());
  },

  async send(text, options = {}) {
    const start = get();
    const resumeData = options.resumeData;
    const deps = start.deps;
    if (start.streaming || !deps) return;
    if (!text.trim() && !resumeData) return;
    if (text.length > BUILDER_PROMPT_LIMIT) {
      set({ error: { title: BUILDER_REQUEST_FAILED, message: BUILDER_PROMPT_TOO_LONG } });
      return;
    }
    if (useWorkflowStore.getState().readOnly) return;

    const controller = new AbortController();
    set({
      abortController: controller,
      streaming: true,
      error: null,
      progress: [],
      questions: null,
      plan: null,
      pendingWebFetch: null,
    });
    if (text.trim()) {
      get().addMessage({ id: newId(), role: 'user', text, createdAt: new Date().toISOString() });
    }
    let ended = false;
    try {
      // a new canvas gets its row first (n8n saves before the first build): the draft then has a version
      // to be reviewed against, and the server a workflow to build for
      if (!useWorkflowStore.getState().meta.id) {
        const created = await saveWorkflow(deps);
        if (!created || controller.signal.aborted) return;
      }
      setBuilderCredentials(await loadCredentials());
      if (controller.signal.aborted) return;
      const wf = useWorkflowStore.getState();
      const body: BuildRequest = {
        workflowId: wf.meta.id as string,
        text,
        workflowData: { id: wf.meta.id, ...toWorkflowBody(wf) },
        mode: get().mode,
        ...(resumeData ? { resumeData } : {}),
      };
      await streamBuild(
        body,
        (chunk) => {
          if (!controller.signal.aborted) get().applyChunk(chunk);
        },
        controller.signal,
      );
      ended = !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) {
        set({ error: { title: BUILDER_REQUEST_FAILED, message: errorMessage(error) } });
        ended = true;
      }
    } finally {
      if (get().abortController === controller) set({ abortController: null, streaming: false });
      setBuilderCredentials([]);
      if (ended) notifyBuilderDone();
    }
  },

  stop() {
    const controller = get().abortController;
    if (controller && !controller.signal.aborted) controller.abort();
    set((s) => ({
      abortController: null,
      streaming: false,
      progress: s.progress.map(
        (p): BuilderProgress => (p.status === 'running' ? { ...p, status: 'error', summary: 'Stopped' } : p),
      ),
    }));
  },

  applyChunk(chunk) {
    switch (chunk.type) {
      case 'message':
        set((s) => ({ messages: withMessage(s.messages, chunk) }));
        return;
      case 'tool':
        set((s) => ({ progress: withProgress(s.progress, chunk) }));
        return;
      case 'workflow-updated': {
        if (useWorkflowStore.getState().readOnly) return;
        if (!get().reviewing) {
          // the canvas before the builder's first change; the review starts before the canvas changes,
          // so autosave never schedules the draft
          const wf = useWorkflowStore.getState();
          set({
            snapshot: { graph: graphOf(wf), versionId: wf.meta.versionId, dirty: wf.dirty },
            reviewing: true,
          });
        }
        applyBuilderChunk(chunk, get().deps);
        return;
      }
      case 'execution-requested':
        get().addMessage({
          id: newId(),
          role: 'assistant',
          text: chunk.reason?.trim() || 'Run the draft to test it.',
          createdAt: new Date().toISOString(),
        });
        return;
      case 'questions':
        set({ questions: chunk.questions });
        return;
      case 'plan':
        set({ plan: chunk.plan });
        return;
      case 'session-messages':
        set({ messages: chunk.messages });
        return;
      case 'web-fetch-approval':
        set({ pendingWebFetch: { url: chunk.url, domain: chunk.domain } });
        return;
      case 'error':
        set({ error: { title: chunk.title, message: chunk.message } });
        return;
    }
  },

  async acceptDraft() {
    const deps = get().deps;
    if (!deps) return false;
    return (await acceptBuilderDraft(deps)) !== null;
  },

  discardDraft() {
    const { snapshot } = get();
    // end the stream first, so no late chunk lands on the restored canvas
    get().clearReview();
    if (!snapshot) return;
    const wf = useWorkflowStore.getState();
    wf.load({ ...wf.meta, ...snapshot.graph, versionId: snapshot.versionId }, { readOnly: wf.readOnly });
    if (snapshot.dirty) useWorkflowStore.setState((s) => ({ dirty: true, revision: s.revision + 1 }));
  },

  async runDraft() {
    const { deps, streaming } = get();
    if (!deps || streaming) return;
    await runWorkflow(deps);
  },

  async loadHistory(workflowId) {
    try {
      const session = await aiApi.sessions(workflowId);
      // a turn started meanwhile, or another workflow is open: its chat wins
      if (get().streaming || useWorkflowStore.getState().meta.id !== workflowId) return;
      const messages = session.messages ?? [];
      const last = messages.at(-1);
      const waiting = last?.role === 'assistant' ? last : undefined;
      set({
        messages,
        // a turn that ended on questions or a plan waits for the answer, also after a reload
        questions: waiting?.questions?.length ? waiting.questions : null,
        plan: waiting?.plan && !waiting.questions?.length ? waiting.plan : null,
      });
    } catch (error) {
      if (useWorkflowStore.getState().meta.id !== workflowId) return;
      set({ error: { title: BUILDER_HISTORY_FAILED, message: errorMessage(error) } });
    }
  },
}));

/**
 * The review guard of the save paths: while a draft is under review, shows `BUILDER_REVIEW_BLOCKED`
 * and returns true (the caller then does nothing). Accept passes `builderAccept` and skips it.
 */
export function refuseWhileReviewing(): boolean {
  if (!useBuilderStore.getState().reviewing) return false;
  toast.info(BUILDER_REVIEW_BLOCKED);
  return true;
}
