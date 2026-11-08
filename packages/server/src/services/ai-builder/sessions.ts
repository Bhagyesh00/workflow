/**
 * Builder sessions on `workflow_builder_sessions` (P5-09, L1; the session routes are L6's). Every
 * query names tenant, workflow and user (`ctx.repos.builderSessions`).
 */
import type { BuilderMessage } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { BuilderSessionRow } from '../../repositories/builder-sessions';
import type { BuilderSession, BuilderSessionKey } from './types';

function fromRow(key: BuilderSessionKey, row: BuilderSessionRow | undefined): BuilderSession {
  return {
    tenantId: key.tenantId,
    workflowId: key.workflowId,
    userId: key.userId,
    messages: Array.isArray(row?.messages) ? structuredClone(row.messages) : [],
    previousSummary: row?.previousSummary ?? null,
    activeVersionCardId: row?.activeVersionCardId ?? null,
    resumeAfterRestoreMessageId: row?.resumeAfterRestoreMessageId ?? null,
    allowedWebDomains: Array.isArray(row?.allowedWebDomains) ? [...row.allowedWebDomains] : [],
  };
}

/** the stored session, or an empty one (no row written) when this user has none for this workflow */
export async function loadSession(ctx: ServerContext, key: BuilderSessionKey): Promise<BuilderSession> {
  const row = await ctx.repos.builderSessions.get(key.tenantId, key.workflowId, key.userId);
  return fromRow(key, row);
}

/**
 * Writes the turn: `session` as the seams left it plus `messages` (the user's message, `text` already
 * through `redactSecrets`, and the assistant's reply with its `plan` or `questions`) appended.
 * Returns the saved session.
 */
export async function saveTurn(
  ctx: ServerContext,
  session: BuilderSession,
  messages: BuilderMessage[],
): Promise<BuilderSession> {
  const { tenantId, workflowId, userId } = session;
  const row = await ctx.repos.builderSessions.upsert(tenantId, workflowId, userId, {
    messages: [...session.messages, ...messages],
    previousSummary: session.previousSummary,
    activeVersionCardId: session.activeVersionCardId,
    resumeAfterRestoreMessageId: session.resumeAfterRestoreMessageId,
    allowedWebDomains: session.allowedWebDomains,
  });
  return fromRow({ tenantId, workflowId, userId }, row);
}
