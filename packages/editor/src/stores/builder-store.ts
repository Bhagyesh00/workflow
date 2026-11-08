/**
 * State of the AI workflow builder (P5-09, P5-62): the chat, the stream of the running turn and the
 * draft under review. While `reviewing` is true the canvas holds the builder's draft, which only
 * Accept saves: every save path refuses with `BUILDER_REVIEW_BLOCKED` (editor-actions.ts `doSave`,
 * autosave, duplicate, convert to sub-workflow). `clearReview` ends a review and any running stream;
 * `reset` also clears the chat, so another workflow never sees this one's stream or draft.
 *
 * C0 holds the state, the setters, `clearReview` and `reset`; L2 fills the actions (`send` ...
 * `loadHistory`), which L3, L4, L5 and L6 call by these names.
 */
import type {
  BuilderChunk,
  BuilderMessage,
  BuilderMode,
  BuilderPlan,
  BuilderQuestion,
  BuilderResume,
} from '@workflow/workflow';
import type { ReactFlowInstance } from '@xyflow/react';
import { create } from 'zustand';
import type { EditorDeps } from '../features/editor/editor-actions';
import type { WorkflowGraph } from '../lib/workflow-ops';
import { toast, useUiStore } from './ui-store';

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

const notImplemented = (): never => {
  throw new Error('not implemented (L2)');
};

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

  send: async () => notImplemented(),
  stop: () => notImplemented(),
  applyChunk: () => notImplemented(),
  acceptDraft: async () => notImplemented(),
  discardDraft: () => notImplemented(),
  runDraft: async () => notImplemented(),
  loadHistory: async () => notImplemented(),
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
