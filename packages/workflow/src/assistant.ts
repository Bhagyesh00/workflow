/**
 * Assistant contracts (Phase 5 S5, P5-67 to P5-74) shared by the server (`/assistant/*`), the editor page
 * and the demo backend: limits, tool permissions, the streamed events (n8n's Instance AI event names) and
 * the DTOs. Isomorphic: no Node API.
 */
import type { DataObject, WorkflowDefinition } from './interfaces';
import type { DoctorIssue } from './workflow-lint';

// ---------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------

/** model round trips in one turn */
export const ASSISTANT_MAX_ITERATIONS = 50;
/** characters of one tool result the model sees */
export const ASSISTANT_RESULT_CHARS = 30000;
/**
 * Model stream guard defaults: no delta for `idleMs` fails the call, no first output for `firstOutputMs`
 * fails it, and a call that streamed nothing is retried `stallRetries` times
 */
export const ASSISTANT_STREAM = { idleMs: 90000, firstOutputMs: 180000, stallRetries: 1 } as const;
/** attachments of one message (n8n's limits): count, base64 length of one file, base64 length of all */
export const ASSISTANT_ATTACHMENTS = {
  maxPerMessage: 10,
  fileBase64Bytes: 10485760,
  totalBase64Bytes: 16777216,
} as const;
/** attachment MIME types the Assistant accepts, each with the file extensions that may carry it */
export const ASSISTANT_ATTACHMENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'application/json': ['.json'],
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/html': ['.html', '.htm'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
};
/** approval card previews: rows and columns shown, characters of one value */
export const ASSISTANT_PREVIEW = { rows: 3, columns: 5, valueChars: 100 } as const;

// ---------------------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------------------

/** the tool permission keys (n8n's list minus preference and skill keys) */
export const ASSISTANT_PERMISSION_KEYS = [
  'createWorkflow',
  'updateWorkflow',
  'runWorkflow',
  'publishWorkflow',
  'deleteWorkflow',
  'createCredential',
  'deleteCredential',
  'createFolder',
  'deleteFolder',
  'moveWorkflowToFolder',
  'tagWorkflow',
  'createDataTable',
  'deleteDataTable',
  'mutateDataTableSchema',
  'mutateDataTableRows',
  'cleanupTestExecutions',
  'fetchUrl',
  'webSearch',
  'restoreWorkflowVersion',
  'executeNode',
  'mcpRead',
  'mcpWrite',
] as const;

export type AssistantPermissionKey = (typeof ASSISTANT_PERMISSION_KEYS)[number];
export type AssistantPermissionMode = 'require_approval' | 'always_allow' | 'blocked';
export type AssistantPermissions = Record<AssistantPermissionKey, AssistantPermissionMode>;

export const ASSISTANT_PERMISSION_MODES: readonly AssistantPermissionMode[] = [
  'require_approval',
  'always_allow',
  'blocked',
];

/**
 * The only keys a saved `always_allow` holds on (decisions: write tools always need a person's approval).
 * `mcpRead` defaults to `require_approval` all the same: a server's read-only hint is untrusted.
 */
export const ASSISTANT_ALWAYS_ALLOW_KEYS: readonly AssistantPermissionKey[] = [
  'fetchUrl',
  'webSearch',
  'mcpRead',
];

export const DEFAULT_ASSISTANT_PERMISSIONS: Readonly<AssistantPermissions> = Object.freeze(
  Object.fromEntries(
    ASSISTANT_PERMISSION_KEYS.map((key) => [key, 'require_approval']),
  ) as AssistantPermissions,
);

export function isAssistantPermissionKey(value: unknown): value is AssistantPermissionKey {
  return typeof value === 'string' && (ASSISTANT_PERMISSION_KEYS as readonly string[]).includes(value);
}

/**
 * The effective permissions from a tenant's saved ones: every key present, unknown keys and values
 * dropped, and a saved `always_allow` on a key outside `ASSISTANT_ALWAYS_ALLOW_KEYS` read as
 * `require_approval`.
 */
export function resolveAssistantPermissions(
  saved?: Partial<Record<string, unknown>> | null,
): AssistantPermissions {
  const out = { ...DEFAULT_ASSISTANT_PERMISSIONS } as AssistantPermissions;
  if (!saved || typeof saved !== 'object') return out;
  for (const key of ASSISTANT_PERMISSION_KEYS) {
    const mode = saved[key];
    if (mode === 'blocked' || mode === 'require_approval') out[key] = mode;
    else if (mode === 'always_allow') {
      out[key] = ASSISTANT_ALWAYS_ALLOW_KEYS.includes(key) ? 'always_allow' : 'require_approval';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Confirmations (cards)
// ---------------------------------------------------------------------------------------------------------

export type AssistantConfirmationInputType = 'approval' | 'questions' | 'domain' | 'credential';

/** one previewed table: values as text, cut to `ASSISTANT_PREVIEW`, with what was left out */
export interface AssistantPreviewTable {
  columns: string[];
  rows: string[][];
  omittedRows: number;
  omittedColumns: number;
}

/** an approval card's facts, read by the server from the stored args (never the model's text) */
export interface AssistantApprovalDetails {
  facts: Array<{ label: string; value: string }>;
  preview?: AssistantPreviewTable;
}

export interface AssistantQuestion {
  /** `q1`, `q2`, ... */
  id: string;
  question: string;
  type: 'single' | 'multi' | 'text';
  options?: string[];
}

export interface AssistantQuestionsDetails {
  introMessage?: string;
  questions: AssistantQuestion[];
}

/** a `fetch_url` domain card: the full URL and its host, shown as text */
export interface AssistantDomainDetails {
  url: string;
  host: string;
}

/** a `setup_credentials` card: the credential type to create or pick */
export interface AssistantCredentialDetails {
  credentialType: string;
  displayName?: string;
  reason?: string;
}

export interface AssistantConfirmationDetailsMap {
  approval: AssistantApprovalDetails;
  questions: AssistantQuestionsDetails;
  domain: AssistantDomainDetails;
  credential: AssistantCredentialDetails;
}

export type AssistantConfirmationDetails = AssistantConfirmationDetailsMap[AssistantConfirmationInputType];

interface AssistantConfirmationBase {
  /** the pending row id, the `:requestId` of `POST /assistant/confirm/:requestId` */
  requestId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  resourceName?: string;
  /** the model's own words about the action, shown apart and labelled as the Assistant's */
  approvalSummary?: string;
  /** "Always allow this session" is offered */
  allowSession: boolean;
  /** null: no timeout, the card shows no countdown */
  expiresAt: string | null;
  createdAt: string;
}

/** one open card, discriminated by `inputType` */
export type AssistantConfirmation = {
  [K in AssistantConfirmationInputType]: AssistantConfirmationBase & {
    inputType: K;
    details: AssistantConfirmationDetailsMap[K];
  };
}[AssistantConfirmationInputType];

/** a person's answer to a card (the client never sends the tool's args) */
export type AssistantConfirmAnswer =
  | { kind: 'approval'; approved: boolean; scope?: 'once' | 'session' }
  | { kind: 'questions'; answers: Array<{ id: string; answer: unknown }>; dismissed?: boolean }
  | { kind: 'domain'; action: 'allow_once' | 'allow_domain' | 'allow_all' | 'deny' }
  | { kind: 'credential'; credentialId: string | null };

/** how a card ended (the row's status after an answer, a timeout or a cancel) */
export type AssistantConfirmationOutcome = 'approved' | 'denied' | 'expired';

// ---------------------------------------------------------------------------------------------------------
// Tasks, artifacts, attachments
// ---------------------------------------------------------------------------------------------------------

export type AssistantTaskStatus = 'todo' | 'in_progress' | 'done' | 'failed' | 'cancelled';

export interface AssistantTask {
  id: string;
  description: string;
  status: AssistantTaskStatus;
  detail?: string;
}

export type AssistantArtifact =
  | { type: 'workflow' | 'data-table'; id: string; name: string }
  | { type: 'draft'; draftId: string; name: string };

/** a stored attachment as clients see it: never the bytes */
export interface AssistantAttachmentRef {
  fileName: string;
  mimeType: string;
  size: number;
}

// ---------------------------------------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------------------------------------

export const ASSISTANT_EVENT_TYPES = [
  'run-start',
  'text-delta',
  'text-block',
  'tool-call',
  'tool-result',
  'tool-error',
  'confirmation-request',
  'confirmation-resolved',
  'tasks-update',
  'artifact',
  'thread-title-updated',
  'status',
  'error',
  'run-finish',
] as const;

export type AssistantEventType = (typeof ASSISTANT_EVENT_TYPES)[number];

/** event types sent live only: never stored, never replayed, sent with no id */
export const ASSISTANT_LIVE_ONLY_EVENTS: readonly AssistantEventType[] = ['text-delta', 'status'];

export type AssistantRunStatus = 'completed' | 'suspended' | 'cancelled' | 'error';

/** payload of each event type */
export interface AssistantEventPayloads {
  /** a turn started; `resumed` after a card was answered */
  'run-start': { resumed: boolean };
  /** a piece of streamed text (live only) */
  'text-delta': { text: string };
  /** the full text of one assistant message; replaces the live segment the deltas built */
  'text-block': { messageId: string; text: string };
  'tool-call': { toolCallId: string; toolName: string; args: DataObject };
  /** `result` is what the model saw (redacted, capped, wrapped when untrusted) */
  'tool-result': { toolCallId: string; toolName: string; result: string };
  'tool-error': { toolCallId: string; toolName: string; error: string };
  'confirmation-request': { confirmation: AssistantConfirmation };
  'confirmation-resolved': { requestId: string; toolCallId: string; outcome: AssistantConfirmationOutcome };
  'tasks-update': { tasks: AssistantTask[] };
  artifact: { artifact: AssistantArtifact };
  'thread-title-updated': { title: string };
  /** progress text, for example a nested build's tool steps (live only) */
  status: { message: string };
  /** a run error, already through `redactSecrets` */
  error: { message: string };
  'run-finish': { status: AssistantRunStatus; reason?: string };
}

/**
 * One streamed event. `id` is the stored event's id (`assistant_events.id`), set on durable events once
 * stored; live-only events carry none. `runId` is null for an event sent outside a turn (an Accept).
 */
export type AssistantEvent = {
  [K in AssistantEventType]: {
    type: K;
    id?: number;
    runId: string | null;
    payload: AssistantEventPayloads[K];
  };
}[AssistantEventType];

export type AssistantEventOf<K extends AssistantEventType> = Extract<AssistantEvent, { type: K }>;

/** stored in `assistant_events` and replayed on reconnect: every type but `text-delta` and `status` */
export function isDurableAssistantEvent(type: AssistantEventType | string): boolean {
  return (
    (ASSISTANT_EVENT_TYPES as readonly string[]).includes(type) &&
    !(ASSISTANT_LIVE_ONLY_EVENTS as readonly string[]).includes(type)
  );
}

// ---------------------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------------------

export interface AssistantThreadDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantToolCallDTO {
  id: string;
  name: string;
  args: DataObject;
}

/** one stored message; `summarized` ones too (only the model's view drops them); attachments as refs only */
export interface AssistantMessageDTO {
  id: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: AssistantToolCallDTO[];
  toolCallId?: string;
  name?: string;
  attachments?: AssistantAttachmentRef[];
  /**
   * On the last assistant message of a run: the run's latest task list, folded from its stored
   * `tasks-update` events up to the page's `nextEventId` (a reload rebuilds the checklist from it).
   */
  tasks?: AssistantTask[];
  /**
   * On the last assistant message of a run: the workflows, data tables and drafts the run showed, folded
   * from its stored `artifact` events (one per id, the latest name), for the artifacts column on a reload.
   */
  artifacts?: AssistantArtifact[];
  summarized: boolean;
  createdAt: string;
}

/** `GET /assistant/threads/:threadId/messages`: stream from `nextEventId - 1` after loading these */
export interface AssistantMessagesPage {
  messages: AssistantMessageDTO[];
  nextEventId: number;
}

/** `GET /assistant/threads/:threadId/status` */
export interface AssistantStatusDTO {
  hasActiveRun: boolean;
  isSuspended: boolean;
  pending: AssistantConfirmation[];
}

export type AssistantDraftStatus = 'open' | 'accepted' | 'discarded';

/** a workflow built in chat, held on the thread until a person accepts or discards it */
export interface AssistantDraftDTO {
  id: string;
  name: string;
  /** the saved workflow the draft changes; null for a new one */
  workflowId: string | null;
  /** the version the draft was built on (Accept sends it as the base) */
  baseVersionId: string | null;
  status: AssistantDraftStatus;
  definition: WorkflowDefinition;
  nodeCount: number;
  issues: DoctorIssue[];
  createdAt: string;
  updatedAt: string;
}

/** `GET /assistant/settings` (admins); credential ids only, never data */
export interface AssistantSettingsDTO {
  enabled: boolean;
  credentialId: string | null;
  nodeType: string | null;
  model: string | null;
  modelSet: boolean;
  searchCredentialId: string | null;
  searchDisabled: boolean;
  mcpAccessEnabled: boolean;
  permissions: AssistantPermissions;
  allowSendingParameterValues: boolean;
  /** false when the instance turned sending parameter values off (the page shows the switch off) */
  instanceAllowsSendingParameterValues: boolean;
}

export type AssistantMcpTransport = 'httpStreamable' | 'sse';
/** the MCP Client node's own `authentication` values, each with its credential slot */
export type AssistantMcpAuthentication =
  | 'none'
  | 'bearerAuth'
  | 'headerAuth'
  | 'multipleHeadersAuth'
  | 'mcpOAuth2Api';

/** a workspace MCP connection: a credential id, never a secret */
export interface AssistantMcpConnectionDTO {
  id: string;
  name: string;
  url: string;
  transport: AssistantMcpTransport;
  authentication: AssistantMcpAuthentication;
  credentialId: string | null;
  enabled: boolean;
  /** per tool name; a missing tool falls back to `mcpRead` or `mcpWrite` */
  toolPermissions: Record<string, AssistantPermissionMode>;
  createdAt: string;
  updatedAt: string;
}

/** `POST /assistant/chat/:threadId` body; `data` is base64 */
export interface AssistantSendMessage {
  message: string;
  attachments?: Array<{ data: string; mimeType: string; fileName: string }>;
}
