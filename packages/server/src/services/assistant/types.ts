/**
 * The Assistant's server types (P5-67 to P5-74), FULL from C0 and C0-final: the caller, the run scope a
 * tool sees, the tool definition every tool file exports, the gate's answer and the effective settings.
 * No lane edits this file; a lane that needs more adds it in its own file.
 */
import type {
  AssistantApprovalDetails,
  AssistantArtifact,
  AssistantAttachmentRef,
  AssistantConfirmAnswer,
  AssistantConfirmationDetailsMap,
  AssistantConfirmationInputType,
  AssistantEvent,
  AssistantPermissionKey,
  AssistantPermissions,
  BinaryData,
} from '@workflow/workflow';
import type { z } from 'zod';
import type { ServerContext } from '../../context';
import type { Role, TenantRow, UserRow } from '../../db/schema';
import type { Actor } from '../workflows';

/**
 * Who a turn runs for. `actor` is `Actor` of services/workflows.ts: `ip` comes from the chat or confirm
 * request and is empty when a sweep resumes a turn (`deleteCredential` gets `run.actor.ip ?? ''`).
 * `role` is the role at the start of the turn; `toAiTools` re-reads it before each call.
 */
export interface AssistantCaller {
  tenant: TenantRow;
  user: UserRow;
  role: Role;
  actor: Actor;
}

/** an attachment of the turn: the reference the DTO shows plus the stored binary (never sent to a client) */
export type StoredAttachment = AssistantAttachmentRef & { binary: BinaryData };

/**
 * The workspace's Assistant settings as a turn uses them (`AssistantSettingsService.read`):
 * `enabled` is `settings.enabled ?? INSTANCE_AI_ENABLED ?? true`; `model` is null until an admin sets a
 * credential, a node type and a model id; `permissions` went through `resolveAssistantPermissions`, so
 * `always_allow` is only ever on `fetchUrl`, `webSearch`, `mcpRead`; `sendValues` is
 * `AI_ALLOW_SENDING_PARAMETER_VALUES && (settings.allowSendingParameterValues ?? true)`.
 */
export interface EffectiveAssistantSettings {
  enabled: boolean;
  model: { credentialId: string; nodeType: string; model: string } | null;
  /** `model !== null` */
  modelSet: boolean;
  searchCredentialId: string | null;
  searchDisabled: boolean;
  mcpAccessEnabled: boolean;
  permissions: AssistantPermissions;
  /** the saved choice (default true); `sendValues` is what applies */
  allowSendingParameterValues: boolean;
  /** `AI_ALLOW_SENDING_PARAMETER_VALUES`: false forces `sendValues` false */
  instanceAllowsSendingParameterValues: boolean;
  sendValues: boolean;
}

/** one turn as a tool sees it (built by `createRunScope` in run.ts for every turn, first or resumed) */
export interface AssistantRunScope extends AssistantCaller {
  threadId: string;
  runId: string;
  /** the turn's signal: cancel, a lost run lock, or the server closing */
  signal: AbortSignal;
  settings: EffectiveAssistantSettings;
  /** `settings.sendValues`, at hand for tools that show run data or parameter values */
  sendValues: boolean;
  /** the attachments of the turn's user message (a resumed turn reloads them through `turnAttachments`) */
  attachments: StoredAttachment[];
  /** send an event of this turn: durable ones are stored first, `text-delta` and `status` are live only */
  emit(event: AssistantEvent): void;
}

/** the copy of an approval card; the facts are read by the server from the stored args, never the model's text */
export interface ApprovalCopy {
  title: string;
  resourceName?: string;
  details: AssistantApprovalDetails;
  /** the model's own summary, shown apart and labelled as the Assistant's words */
  approvalSummary?: string;
}

/** a card other than an approval (questions, domain, credential); `grantKey` null offers no "always allow" */
export type AssistantSuspend = {
  [K in AssistantConfirmationInputType]: {
    inputType: K;
    details: AssistantConfirmationDetailsMap[K];
    title?: string;
    resourceName?: string;
    grantKey?: string | null;
  };
}[AssistantConfirmationInputType];

/**
 * One Assistant tool. Every tool file exports an array of these (`<name>Tools`), and `assistantTools`
 * (tools/index.ts) joins them. A tool with `permission` goes through `approvals.gate` (L3): blocked
 * refuses, `always_allow` (three keys only) proceeds, a thread grant for `grantKey` proceeds, else a card.
 * `suspendFor` gives a card other than an approval (null: go on). `resume` runs an approved call with the
 * person's answer; without it the approved call runs `handler`. `untrusted` names the source for
 * `wrapUntrusted` in `shapeToolResult`. `available(run)` false: the tool is not offered this turn and a
 * forged call gets an error result.
 */
export interface AssistantToolDefinition<I = any> {
  /** [a-zA-Z0-9_-]{1,64}, unique in a turn */
  name: string;
  description: string;
  input: z.ZodType<I>;
  minRole: Role;
  permission?: AssistantPermissionKey;
  available?(run: AssistantRunScope): boolean;
  artifact?(input: I, result: unknown): AssistantArtifact | null;
  approval?(ctx: ServerContext, caller: AssistantCaller, input: I): Promise<ApprovalCopy>;
  /** the thread grant this call matches for "always allow this session"; null: no session button */
  grantKey?(input: I): string | null;
  suspendFor?(ctx: ServerContext, run: AssistantRunScope, input: I): Promise<AssistantSuspend | null>;
  resume?(
    ctx: ServerContext,
    run: AssistantRunScope,
    input: I,
    answer: AssistantConfirmAnswer,
  ): Promise<unknown>;
  /** source name for `wrapUntrusted` (for example `web-page`, `mcp:<connection>`, `execution-output`) */
  untrusted?: string;
  handler(ctx: ServerContext, run: AssistantRunScope, input: I): Promise<unknown>;
}

/**
 * What `approvals.gate` decides for one call: run it now, refuse it with a reason the model reads, or a
 * card was written and the model gets `placeholder` until the person answers.
 */
export type GateResult =
  | { decision: 'proceed' }
  | { decision: 'refuse'; reason: string }
  | { decision: 'suspended'; placeholder: string };

/**
 * Thrown by the recording model wrapper before the next model call when this turn holds a pending card:
 * the turn stops (`run-finish` `suspended`) and resumes from the stored history after the answer.
 */
export class AssistantTurnStop extends Error {
  override name = 'AssistantTurnStop';
  constructor(readonly reason: 'suspended' = 'suspended') {
    super('The turn waits for a person');
  }
}
