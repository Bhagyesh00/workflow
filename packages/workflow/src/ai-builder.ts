/**
 * AI Workflow Builder contracts shared by the server (POST /ai/build), the editor panel and the
 * demo backend: limits, the request, the resume data and the streamed chunks (n8n's chunk type
 * names). Isomorphic: no Node API.
 */
import type { WorkflowDefinition } from './interfaces';

/** longest prompt a user may send, in characters */
export const BUILDER_PROMPT_LIMIT = 5000;
export const BUILDER_PROMPT_TOO_LONG = 'Message exceeds maximum length of 5000 characters';
/** model round trips in one turn */
export const BUILDER_MAX_ITERATIONS = 50;
/** validate, fix, validate again: at most this many attempts per turn */
export const BUILDER_MAX_VALIDATE_ATTEMPTS = 10;
/** estimated tokens of workflow context sent with a turn before trimming */
export const BUILDER_CONTEXT_TOKENS = 30000;
/** characters a long parameter value is cut to, step by step, until the context fits */
export const BUILDER_TRIM_STEPS = [10000, 5000, 2000, 1000] as const;
/** characters of one parameter value the model sees */
export const BUILDER_VALUE_LIMIT = 30000;
/** characters of execution data the model sees */
export const BUILDER_EXECUTION_DATA_LIMIT = 10000;
/** estimated session tokens at which the history is compacted */
export const BUILDER_COMPACT_TOKENS = 150000;
/** `web_fetch` limits: fetches per turn, timeout, bytes read, characters kept */
export const BUILDER_WEB_FETCH = {
  perTurn: 3,
  timeoutMs: 20000,
  maxBytes: 2097152,
  maxChars: 30000,
} as const;

export type BuilderMode = 'build' | 'plan';

/** the answer to what stopped the last turn: questions, a plan, or a web fetch approval */
export type BuilderResume =
  | { answers: Array<{ id: string; answer: string }> }
  | { planDecision: 'approve' | 'modify' | 'reject'; feedback?: string }
  | { webFetch: { url: string; decision: 'approve' | 'deny' } };

/** body of POST /ai/build */
export interface BuildRequest {
  workflowId: string;
  text: string;
  /** the editor's current (maybe unsaved) workflow */
  workflowData?: unknown;
  mode?: BuilderMode;
  resumeData?: BuilderResume;
}

/** one question of plan mode (`submit_questions`) */
export interface BuilderQuestion {
  id: string;
  question: string;
  /** `single` and `multi` pick from `options`; `text` is free text */
  type: 'single' | 'multi' | 'text';
  options?: string[];
}

/** one step of a plan */
export interface BuilderPlanStep {
  description: string;
  /** node types the step expects to use */
  nodeTypes?: string[];
}

/** the plan of plan mode (`submit_plan`), approved, modified or rejected by the user */
export interface BuilderPlan {
  summary: string;
  /** how the workflow starts */
  trigger?: string;
  steps: BuilderPlanStep[];
  /** extra notes or assumptions */
  notes?: string[];
}

/**
 * One message of a builder session. An assistant message is the home of a plan and of questions
 * between requests, since `resumeData` carries only the decision.
 */
export interface BuilderMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** the workflow version this message produced or was sent against */
  versionId?: string;
  /** ISO date */
  createdAt: string;
  plan?: BuilderPlan;
  questions?: BuilderQuestion[];
}

/** one streamed chunk of POST /ai/build (n8n's type names) */
export type BuilderChunk =
  | { type: 'message'; id: string; text: string; delta?: boolean }
  | { type: 'tool'; toolName: string; status: 'running' | 'done' | 'error'; summary?: string }
  | { type: 'workflow-updated'; workflow: WorkflowDefinition }
  | { type: 'execution-requested'; reason?: string }
  | { type: 'questions'; questions: BuilderQuestion[] }
  | { type: 'plan'; plan: BuilderPlan }
  | { type: 'session-messages'; messages: BuilderMessage[] }
  | { type: 'web-fetch-approval'; url: string; domain: string }
  | { type: 'error'; title: string; message: string };
