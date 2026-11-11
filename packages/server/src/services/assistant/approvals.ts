/**
 * Approvals (P5-68, lane L3): the gate before every gated call, the person's answer, the run of an
 * approved call and the card timeout. Built with the same `extraTools` as the service, so an approved
 * test tool is found again.
 *
 * `gate`, in this order: a `blocked` permission refuses; `always_allow` proceeds (only on the keys of
 * `ASSISTANT_ALWAYS_ALLOW_KEYS`); a grant on the thread for the call's `grantKey` proceeds; `suspendFor`
 * gives its card or null (null proceeds); else `approval` builds the copy. A card is a row holding the
 * stored args, a `confirmation-request` event and, for the model, the placeholder `Waiting for the
 * person's approval`. The card's facts are the server's reading of the args; the model's own summary is
 * kept apart (`approvalSummary`) and the editor labels it as the Assistant's words.
 *
 * `confirm` only claims and answers (it never runs a tool): the claim is one atomic update naming the
 * tenant, the user and the id, so a second answer, an expired card, another user's or another tenant's
 * card is 404. When the turn has no `pending` card left it starts `assistant.settleConfirmations`, which
 * runs each approved call through `runApproved` under its own run lock, heartbeat and AbortController.
 *
 * `runApproved` finds the definition again (`assistantTools` for the role now, then
 * `resolveDynamicTool`), re-reads the role and the permission, parses the stored args (the client sends
 * none) and runs `resume` with the answer, else `handler`; the result goes through `shapeToolResult`
 * into the call's tool message. `sweepExpired` ends cards past their time and, from the timer, approved
 * cards whose run is gone (never rerun: the write may have happened).
 */
import {
  ASSISTANT_ALWAYS_ALLOW_KEYS,
  ASSISTANT_PREVIEW,
  type AssistantApprovalDetails,
  type AssistantConfirmAnswer,
  type AssistantConfirmation,
  type AssistantConfirmationOutcome,
  type AssistantPermissionKey,
  type AssistantPermissions,
  type AssistantPreviewTable,
  type DataObject,
  redactSecrets,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { TenantSettings } from '../../plans';
import type { AssistantConfirmationRow } from '../../repositories/assistant-confirmations';
import { PROTECTED_TEXT } from '../protected';
import type { Actor } from '../workflows';
import { redactDeep } from './events';
import { protectedActionForTool, toolPermissionMode } from './settings';
import { ASSISTANT_STALE_RUN_MS } from './sweep';
import { ASSISTANT_TOOL_NO_ACCESS, shapeToolError, shapeToolResult } from './tool-adapter';
import { assistantTools, builtInAssistantTools, resolveDynamicTool } from './tools';
import {
  type ApprovalCopy,
  type AssistantRunScope,
  type AssistantSuspend,
  type AssistantToolDefinition,
  type GateResult,
  homeScopes,
  toolDenial,
} from './types';

/** the texts the model reads in place of a gated call's result */
export const ASSISTANT_APPROVAL_TEXTS = {
  waiting: "Waiting for the person's approval",
  refused: 'The person refused this',
  timedOut: 'The approval timed out, so this did not run',
  runStopped: 'The run stopped before this ran',
  blocked: 'An admin turned this off',
} as const;

/** why a blocked key is blocked: the protected workspace's refusal, else the admin's block */
function blockedText(
  settings: TenantSettings | null | undefined,
  def: { permission?: AssistantPermissionKey; protectedAllowed?: boolean },
): string {
  const action = protectedActionForTool(settings, def);
  return action ? PROTECTED_TEXT[action] : ASSISTANT_APPROVAL_TEXTS.blocked;
}

/** an approved call whose tool is gone by the time it would run (a removed tool or MCP server) */
export const ASSISTANT_APPROVED_TOOL_GONE = 'This tool is no longer available, so it did not run';
/** an approved call cut off by a cancel while it ran (it may have done part of its work) */
export const ASSISTANT_APPROVED_RUN_STOPPED = 'The run was stopped while this ran';
/** the 404 of a card that is not the caller's, was answered already or ran out of time */
export const ASSISTANT_CARD_NOT_FOUND = 'Approval request';

/** an approved card left `approved` this long after its answer with no run on its thread is orphaned */
export const ASSISTANT_ORPHAN_APPROVED_MS = ASSISTANT_STALE_RUN_MS;
/** characters of one fact value and of the model's summary on a card */
const FACT_CHARS = 500;
const SUMMARY_CHARS = 500;

const iso = (value: Date | string) => new Date(value).toISOString();

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** one value as card text: strings as they are, null and undefined empty, the rest as JSON */
export function previewValue(value: unknown, max: number = ASSISTANT_PREVIEW.valueChars): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === null || value === undefined) text = '';
  else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = String(value);
    }
  } else text = String(value);
  return cut(redactSecrets(text), max);
}

/**
 * Rows as an approval card's preview: the first `ASSISTANT_PREVIEW.rows` rows and `columns` columns
 * (the given order, else the keys in first-seen order), values as text cut to `valueChars`, and the
 * counts left out.
 */
export function approvalPreview(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns?: readonly string[],
): AssistantPreviewTable {
  const all = columns ? [...columns] : [];
  if (!columns) {
    for (const row of rows) {
      for (const key of Object.keys(row ?? {})) if (!all.includes(key)) all.push(key);
    }
  }
  const shown = all.slice(0, ASSISTANT_PREVIEW.columns);
  return {
    columns: shown.map((column) => previewValue(column)),
    rows: rows
      .slice(0, ASSISTANT_PREVIEW.rows)
      .map((row) => shown.map((column) => previewValue(row?.[column]))),
    omittedRows: Math.max(0, rows.length - ASSISTANT_PREVIEW.rows),
    omittedColumns: Math.max(0, all.length - shown.length),
  };
}

/** a card's details held to `ASSISTANT_PREVIEW` whatever the tool gave, every value as cut, redacted text */
function boundDetails(details: AssistantApprovalDetails): AssistantApprovalDetails {
  const facts = (Array.isArray(details?.facts) ? details.facts : []).map((fact) => ({
    label: previewValue(fact?.label, 100),
    value: previewValue(fact?.value, FACT_CHARS),
  }));
  const preview = details?.preview;
  if (!preview) return { facts };
  const columns = (preview.columns ?? []).map((column) => previewValue(column));
  const keep = Math.min(columns.length, ASSISTANT_PREVIEW.columns);
  const rows = preview.rows ?? [];
  return {
    facts,
    preview: {
      columns: columns.slice(0, keep),
      rows: rows
        .slice(0, ASSISTANT_PREVIEW.rows)
        .map((row) => (row ?? []).slice(0, keep).map((value) => previewValue(value))),
      omittedRows:
        Math.max(0, Number(preview.omittedRows) || 0) + Math.max(0, rows.length - ASSISTANT_PREVIEW.rows),
      omittedColumns: Math.max(0, Number(preview.omittedColumns) || 0) + Math.max(0, columns.length - keep),
    },
  };
}

/** `delete_workflow` -> `Delete workflow` */
function toolTitle(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** a definition with no `approval`: its name as the title, the stored args as plain facts */
function defaultCopy(def: AssistantToolDefinition, args: DataObject): ApprovalCopy {
  return {
    title: toolTitle(def.name),
    details: { facts: Object.entries(args).map(([label, value]) => ({ label, value: previewValue(value) })) },
  };
}

/** the args as stored: plain JSON of the parsed input */
function storedArgs(input: unknown): DataObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return JSON.parse(JSON.stringify(input)) as DataObject;
}

/** what an answer makes of the card: a denied approval and a domain `deny` are `denied` */
function statusOf(answer: AssistantConfirmAnswer): 'approved' | 'denied' {
  if (answer.kind === 'approval') return answer.approved === true ? 'approved' : 'denied';
  if (answer.kind === 'domain') return answer.action === 'deny' ? 'denied' : 'approved';
  return 'approved';
}

interface CardInput {
  inputType: AssistantConfirmation['inputType'];
  details: AssistantConfirmation['details'];
  title: string;
  resourceName?: string;
  approvalSummary?: string;
  grantKey: string | null;
}

export class AssistantApprovals {
  constructor(
    readonly deps: ServiceDeps,
    readonly extraTools: AssistantToolDefinition[] = [],
  ) {}

  private get cards() {
    return this.deps.repos.assistantConfirmations;
  }

  private get threads() {
    return this.deps.repos.assistantThreads;
  }

  /** the workspace's permissions now (an admin may change them during a turn) */
  private async permissionsNow(
    run: AssistantRunScope,
  ): Promise<{ permissions: AssistantPermissions; settings: TenantSettings | null | undefined }> {
    const ctx = this.deps.context();
    const tenant = (await ctx.repos.tenants.get(run.tenant.id)) ?? run.tenant;
    const permissions = (await ctx.assistantSettings.read(tenant)).permissions;
    return { permissions, settings: tenant.settings as TenantSettings | null | undefined };
  }

  /** in order: blocked, always allow, thread grant, `suspendFor`, else an approval card */
  async gate(
    run: AssistantRunScope,
    def: AssistantToolDefinition,
    input: unknown,
    toolCallId: string,
  ): Promise<GateResult> {
    if (def.permission === undefined && def.suspendFor === undefined) return { decision: 'proceed' };
    const ctx = this.deps.context();

    if (def.permission !== undefined) {
      const now = await this.permissionsNow(run);
      // a protected workspace refuses before any card is written or any grant is read
      const action = protectedActionForTool(now.settings, def);
      if (action) return { decision: 'refuse', reason: PROTECTED_TEXT[action] };
      const mode = toolPermissionMode(ctx.config, now.settings, { permissions: now.permissions }, def);
      if (mode === 'blocked') return { decision: 'refuse', reason: ASSISTANT_APPROVAL_TEXTS.blocked };
      if (mode === 'always_allow' && ASSISTANT_ALWAYS_ALLOW_KEYS.includes(def.permission)) {
        return { decision: 'proceed' };
      }
    }

    const grantKey = def.grantKey?.(input) ?? null;
    if (grantKey) {
      const thread = await this.threads.get(run.tenant.id, run.user.id, run.threadId);
      if (thread?.grants.includes(grantKey)) return { decision: 'proceed' };
    }

    if (def.suspendFor !== undefined) {
      const suspend: AssistantSuspend | null = await def.suspendFor(ctx, run, input);
      if (!suspend) return { decision: 'proceed' };
      return this.writeCard(run, def, input, toolCallId, {
        inputType: suspend.inputType,
        details: suspend.details,
        title: suspend.title ?? toolTitle(def.name),
        resourceName: suspend.resourceName,
        grantKey: suspend.grantKey !== undefined ? suspend.grantKey : grantKey,
      });
    }

    const args = storedArgs(input);
    const copy = def.approval ? await def.approval(ctx, run, input) : defaultCopy(def, args);
    return this.writeCard(run, def, input, toolCallId, {
      inputType: 'approval',
      details: boundDetails(copy.details),
      title: copy.title,
      resourceName: copy.resourceName,
      approvalSummary: copy.approvalSummary,
      grantKey,
    });
  }

  /** stores the card with the args, emits `confirmation-request`, and gives the model the placeholder */
  private async writeCard(
    run: AssistantRunScope,
    def: AssistantToolDefinition,
    input: unknown,
    toolCallId: string,
    card: CardInput,
  ): Promise<GateResult> {
    const timeout = this.deps.config.assistant.confirmationTimeoutMs;
    const now = new Date();
    const expiresAt = timeout > 0 ? new Date(now.getTime() + timeout) : null;
    const row = await this.cards.create(run.tenant.id, {
      userId: run.user.id,
      threadId: run.threadId,
      runId: run.runId,
      toolCallId,
      toolName: def.name,
      args: storedArgs(input),
      inputType: card.inputType,
      details: redactDeep(card.details),
      grantKey: card.grantKey,
      expiresAt,
    });
    const confirmation = {
      requestId: row.id,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      title: cut(redactSecrets(card.title || toolTitle(def.name)), 200),
      ...(card.resourceName ? { resourceName: cut(redactSecrets(card.resourceName), 200) } : {}),
      ...(card.approvalSummary
        ? { approvalSummary: cut(redactSecrets(card.approvalSummary), SUMMARY_CHARS) }
        : {}),
      allowSession: row.inputType === 'approval' && Boolean(row.grantKey),
      expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
      createdAt: iso(row.createdAt),
      inputType: row.inputType,
      details: row.details,
    } as AssistantConfirmation;
    run.emit({ type: 'confirmation-request', runId: run.runId, payload: { confirmation } });
    return { decision: 'suspended', placeholder: ASSISTANT_APPROVAL_TEXTS.waiting };
  }

  /** the person's answer; claims the row atomically (tenant, user, id), then settles the turn */
  async confirm(
    auth: AuthContext,
    requestId: string,
    answer: AssistantConfirmAnswer,
    actor?: Actor,
  ): Promise<{ ok: true }> {
    const ctx = this.deps.context();
    const tenantId = auth.tenant.id;
    const userId = auth.user.id;
    const row = await this.cards.get(tenantId, userId, requestId);
    if (row?.status !== 'pending') throw ApiError.notFound(ASSISTANT_CARD_NOT_FOUND);
    if (answer.kind !== row.inputType) {
      throw ApiError.badRequest(`This request takes an answer of kind "${row.inputType}"`);
    }
    const status = statusOf(answer);
    const claimed = await this.cards.claim(tenantId, userId, row.id, status, answer, new Date());
    if (!claimed) throw ApiError.notFound(ASSISTANT_CARD_NOT_FOUND);

    if (status === 'denied') {
      await this.writeResult(claimed, claimed.runId, ASSISTANT_APPROVAL_TEXTS.refused);
    } else if (
      answer.kind === 'approval' &&
      answer.scope === 'session' &&
      claimed.inputType === 'approval' &&
      claimed.grantKey
    ) {
      await this.threads.addGrant(tenantId, claimed.threadId, claimed.grantKey);
    }
    await this.resolved(claimed, status);

    // the last answer of the turn settles it; two answers at once both see none left, and the run lock
    // lets one of them settle. A sibling past its time is expired first, so the settle reads its
    // timeout text, not the placeholder.
    await this.sweepExpired(new Date(), claimed.threadId);
    const left = await this.cards.listPending(tenantId, userId, claimed.threadId);
    if (!left.length) {
      void ctx.assistant
        .settleConfirmations(tenantId, userId, claimed.threadId, actor ?? { userId })
        .catch(() => {});
    }
    return { ok: true };
  }

  /** `confirmation-resolved` through the service's one door for events outside a turn */
  private async resolved(
    row: AssistantConfirmationRow,
    outcome: AssistantConfirmationOutcome,
  ): Promise<void> {
    await this.deps.context().assistant.publish(row.tenantId, row.threadId, {
      type: 'confirmation-resolved',
      runId: row.runId,
      payload: { requestId: row.id, toolCallId: row.toolCallId, outcome },
    });
  }

  /** the call's tool message gets `content` (in place of the placeholder; added when it has none) */
  private async writeResult(
    row: AssistantConfirmationRow,
    runId: string | null,
    content: string,
  ): Promise<void> {
    const replaced = await this.threads.replaceToolResult(
      row.tenantId,
      row.threadId,
      row.toolCallId,
      content,
    );
    if (!replaced) {
      await this.threads.appendMessage(row.tenantId, row.threadId, {
        runId,
        role: 'tool',
        content,
        toolCallId: row.toolCallId,
        name: row.toolName,
      });
    }
  }

  /** an approved call that may no longer run: its result is the refusal, the card is denied */
  private async refuseApproved(
    run: AssistantRunScope,
    row: AssistantConfirmationRow,
    text: string,
  ): Promise<void> {
    await this.writeResult(row, run.runId, `Error: ${text}`);
    await this.cards.refuseApproved(row.tenantId, row.userId, row.id, text);
    run.emit({
      type: 'tool-error',
      runId: run.runId,
      payload: { toolCallId: row.toolCallId, toolName: row.toolName, error: text },
    });
  }

  /** runs one approved call with its stored args (`resume` or `handler`), under the settle's run lock */
  async runApproved(run: AssistantRunScope, row: AssistantConfirmationRow): Promise<void> {
    const ctx = this.deps.context();
    const tenantId = run.tenant.id;
    // the card as it is now: a cancel may have denied it since the settle listed it
    const current = await this.cards.get(tenantId, run.user.id, row.id);
    if (current?.status !== 'approved' || current.threadId !== run.threadId) return;
    if (run.signal.aborted) return;

    const tenant = (await ctx.repos.tenants.get(tenantId)) ?? run.tenant;
    const settings = await ctx.assistantSettings.read(tenant);
    const membership = await ctx.repos.memberships.get(tenantId, run.user.id);
    if (!membership) return this.refuseApproved(run, current, ASSISTANT_TOOL_NO_ACCESS);

    // the membership and scopes as they are now (a lost project or a narrowed role refuses the call)
    const caller = { tenant, user: run.user, role: membership.role };
    let dynamic: { tool: AssistantToolDefinition; close(): Promise<void> } | undefined;
    try {
      let def = (await assistantTools(ctx, caller, settings, this.extraTools)).find(
        (candidate) => candidate.name === current.toolName,
      );
      if (!def) {
        dynamic = await resolveDynamicTool(ctx, run, current.toolName, current.grantKey);
        def = dynamic?.tool;
      }
      if (!def) {
        // why it is not offered now: the role, an admin's block, or the tool is gone
        const known = [...builtInAssistantTools(), ...this.extraTools].find(
          (candidate) => candidate.name === current.toolName,
        );
        const text = !known
          ? ASSISTANT_APPROVED_TOOL_GONE
          : (await toolDenial(ctx, caller, known))
            ? ASSISTANT_TOOL_NO_ACCESS
            : known.permission !== undefined &&
                toolPermissionMode(ctx.config, tenant.settings as TenantSettings, settings, known) ===
                  'blocked'
              ? blockedText(tenant.settings as TenantSettings, known)
              : ASSISTANT_APPROVED_TOOL_GONE;
        return await this.refuseApproved(run, current, text);
      }
      // the permission now, not the one the card was written under
      if (toolPermissionMode(ctx.config, tenant.settings as TenantSettings, settings, def) === 'blocked') {
        return await this.refuseApproved(run, current, blockedText(tenant.settings as TenantSettings, def));
      }
      const parsed = def.input.safeParse(current.args ?? {});
      if (!parsed.success) {
        return await this.refuseApproved(run, current, `Invalid arguments for "${def.name}"`);
      }
      // the scope now, on the target the stored args name: a project lost since the card was written
      // refuses the call before the handler runs
      const denied = await toolDenial(ctx, caller, def, parsed.data);
      if (denied) return await this.refuseApproved(run, current, denied);
      const scope: AssistantRunScope = {
        ...run,
        tenant,
        role: membership.role,
        scopes: await homeScopes(ctx, caller),
        settings,
        sendValues: settings.sendValues,
      };

      let result: unknown;
      try {
        result = def.resume
          ? await def.resume(ctx, scope, parsed.data, current.answer as AssistantConfirmAnswer)
          : await def.handler(ctx, scope, parsed.data);
      } catch (error) {
        // it ran (perhaps in part): never again
        const text = run.signal.aborted ? ASSISTANT_APPROVED_RUN_STOPPED : shapeToolError(def, error);
        await this.writeResult(current, run.runId, `Error: ${text}`);
        await this.cards.markExecuted(tenantId, current.id, current.userId);
        run.emit({
          type: 'tool-error',
          runId: run.runId,
          payload: { toolCallId: current.toolCallId, toolName: current.toolName, error: text },
        });
        return;
      }

      const shaped = shapeToolResult(def, result);
      await this.writeResult(current, run.runId, shaped);
      await this.cards.markExecuted(tenantId, current.id, current.userId);
      run.emit({
        type: 'tool-result',
        runId: run.runId,
        payload: { toolCallId: current.toolCallId, toolName: current.toolName, result: shaped },
      });
      const artifact = def.artifact?.(parsed.data, result);
      if (artifact)
        run.emit({ type: 'artifact', runId: run.runId, payload: { artifact: redactDeep(artifact) } });
    } finally {
      await dynamic?.close().catch(() => {});
    }
  }

  /**
   * Cards past `expires_at` become `expired` (the call reads that the approval timed out). With no
   * `threadId` (the 30 s timer) also `approved` cards whose thread has had no run for
   * `ASSISTANT_ORPHAN_APPROVED_MS` (a crash after the claim) become `expired`, and each thread touched
   * with no pending card left goes on through `settleConfirmations`. With a `threadId` (a new chat) it
   * only clears that thread's rows, since the chat's own turn goes on.
   */
  async sweepExpired(now: Date, threadId?: string): Promise<void> {
    const touched = new Map<string, AssistantConfirmationRow>();
    for (const row of await this.cards.sweepExpired(now, threadId)) {
      await this.endBySystem(row, ASSISTANT_APPROVAL_TEXTS.timedOut);
      touched.set(`${row.tenantId}:${row.threadId}`, row);
    }
    if (threadId !== undefined) return;

    const before = new Date(now.getTime() - ASSISTANT_ORPHAN_APPROVED_MS);
    for (const row of await this.cards.sweepOrphanApproved(before)) {
      await this.endBySystem(row, ASSISTANT_APPROVAL_TEXTS.runStopped);
      touched.set(`${row.tenantId}:${row.threadId}`, row);
    }
    const ctx = this.deps.context();
    for (const row of touched.values()) {
      try {
        if ((await this.cards.listPending(row.tenantId, row.userId, row.threadId, now)).length) continue;
        void ctx.assistant
          .settleConfirmations(row.tenantId, row.userId, row.threadId, { userId: row.userId })
          .catch(() => {});
      } catch (error) {
        this.deps.logger.warn(
          {
            tenantId: row.tenantId,
            threadId: row.threadId,
            error: error instanceof Error ? error.name : 'unknown',
          },
          'Assistant card settle failed',
        );
      }
    }
  }

  /** a card the server ended: its call reads `text`, and the card leaves every open client */
  private async endBySystem(row: AssistantConfirmationRow, text: string): Promise<void> {
    try {
      await this.writeResult(row, row.runId, text);
      await this.resolved(row, 'expired');
    } catch (error) {
      this.deps.logger.warn(
        {
          tenantId: row.tenantId,
          threadId: row.threadId,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'Assistant card sweep failed',
      );
    }
  }
}
