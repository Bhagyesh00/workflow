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
  Scope,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import type { Role, TenantRow, UserRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { type AccessTarget, MISSING_SCOPE_MESSAGE } from '../access';
import type { Actor } from '../workflows';

/**
 * Who a turn runs for. `actor` is `Actor` of services/workflows.ts: `ip` comes from the chat or confirm
 * request and is empty when a sweep resumes a turn (`deleteCredential` gets `run.actor.ip ?? ''`).
 * `role` is the workspace role at the start of the turn and `scopes` the scopes it gave then, global ones
 * plus those of the project the caller's writes default to. Neither is trusted later: `toAiTools` and an
 * approved call re-read the membership and the scopes (`homeScopes`, `scopesOn`) before each call.
 */
export interface AssistantCaller {
  tenant: TenantRow;
  user: UserRow;
  role: Role;
  /** absent in a scope built by hand (a test); nothing trusts it, the checks read the scopes themselves */
  scopes?: ReadonlySet<Scope>;
  actor: Actor;
}

/** a fresh `AuthContext` of the caller (no scope cache: every call reads the scopes anew) */
export function authOf(caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>): AuthContext {
  return { user: caller.user, tenant: caller.tenant, role: caller.role };
}

/**
 * The scopes the caller holds where its writes land: the global ones plus those of the project
 * `AccessService.targetProject` names without an id (the personal project once L24 has cut over). This
 * is what decides whether a tool is offered; a call with a target checks the target as well.
 */
export async function homeScopes(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>,
): Promise<ReadonlySet<Scope>> {
  const auth = authOf(caller);
  return ctx.access.scopesForAuth(auth, { projectId: await ctx.access.targetProject(auth) });
}

/** the scopes the caller holds on `target` (a project, workflow, credential, data table, folder or run) */
export async function scopesOn(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>,
  target: AccessTarget,
): Promise<ReadonlySet<Scope>> {
  return ctx.access.scopesForAuth(authOf(caller), target);
}

/** 403 with n8n's text unless the caller holds `scope` on `target` (a project or resource) */
export async function assertScope(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>,
  scope: Scope,
  target: AccessTarget,
): Promise<void> {
  if (!(await scopesOn(ctx, caller, target)).has(scope)) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
}

/**
 * The project a write lands in: the one the call names (it must be a project of the workspace, 404
 * otherwise), else the caller's default (`targetProject`); the caller must hold `scope` there.
 */
export async function writeProject(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>,
  scope: Scope,
  projectId?: string | null,
): Promise<string> {
  const id = await ctx.access.targetProject(authOf(caller), projectId);
  await assertScope(ctx, caller, scope, { projectId: id });
  return id;
}

/** the scope a definition needs (`access`) */
export function toolAccess(def: Pick<AssistantToolDefinition, 'access'>): Scope {
  return def.access;
}

/** what the model reads when the caller has lost the access a tool needs (also while a call is checked) */
export const ASSISTANT_TOOL_NO_ACCESS = 'You no longer have access to this tool';

/**
 * Why the caller may not use a tool now, or null. Without a target, or while the tool is only listed,
 * the scopes where the caller's writes land decide. With the target the input names (a project, a
 * workflow, a data table, a run...) that target decides, read now: a lost project or a narrowed role
 * stops the next call and an approved call that was waiting. A target of another workspace is left to
 * the handler, which answers "not found".
 */
export async function toolDenial(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user' | 'role'>,
  def: Pick<AssistantToolDefinition, 'access' | 'target'>,
  input?: unknown,
): Promise<string | null> {
  const scope = toolAccess(def);
  const target = input !== undefined && def.target ? def.target(input) : null;
  if (!target) return (await homeScopes(ctx, caller)).has(scope) ? null : ASSISTANT_TOOL_NO_ACCESS;
  try {
    return (await scopesOn(ctx, caller, target)).has(scope) ? null : MISSING_SCOPE_MESSAGE;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) return null;
    throw error;
  }
}

/** the `projectId` every list and create tool takes: one project of the workspace, checked against the caller's scopes */
export const projectIdInput = z
  .uuid()
  .optional()
  .describe('Only this project; it must be one you can reach (see list_projects)');

/** the `scope` of the list tools: which of the caller's work a list shows */
export const listScopeInput = z
  .enum(['all', 'personal', 'shared'])
  .default('all')
  .describe(
    '"all" shows everything you can read, "personal" only your own project, "shared" only what others shared with your project',
  );

export interface ListNarrowing {
  projectId?: string;
  onlySharedWithMe?: boolean;
  /** true: the caller has no personal project, so `scope` matches nothing */
  none?: boolean;
}

/**
 * Turns `projectId` and `scope` of a list tool into the service's narrowing. It only narrows: the list
 * service still applies the caller's access filter, and a `projectId` the caller cannot list is 403 there.
 */
export async function listNarrowing(
  ctx: ServerContext,
  caller: Pick<AssistantCaller, 'tenant' | 'user'>,
  input: { projectId?: string; scope?: 'all' | 'personal' | 'shared' },
): Promise<ListNarrowing> {
  if (input.projectId) return { projectId: input.projectId, onlySharedWithMe: input.scope === 'shared' };
  if (input.scope === 'shared') return { onlySharedWithMe: true };
  if (input.scope === 'personal') {
    const personal = await ctx.repos.projects.getPersonal(caller.tenant.id, caller.user.id);
    return personal ? { projectId: personal.id } : { none: true };
  }
  return {};
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
  /**
   * The scope the caller needs (P6-37): held where the writes land to be offered, then on `target`. Every
   * tool sets it, an MCP tool too.
   */
  access: Scope;
  /** what the call acts on, from its input: a project (`projectId` given), a workflow, a data table...; absent or null: the home scopes decide */
  target?(input: I): AccessTarget | null;
  permission?: AssistantPermissionKey;
  /**
   * The tool stays offered and runs on a protected workspace although its `permission` key is forced
   * `blocked` there (it writes no workspace content: `stop_execution`). Only an admin's own block applies.
   */
  protectedAllowed?: boolean;
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
