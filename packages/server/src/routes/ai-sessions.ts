/**
 * /rest/ai session routes (P5-66, L6), all editor: POST `/ai/sessions` (this workflow's messages for
 * this user only), `/ai/build/truncate-messages` (removes a message and the later ones, records
 * `resume_after_restore_message_id`), `/ai/build/clear-session`, `/ai/build/accepted-version` (writes
 * `active_version_card_id`, tags the last message with `versionId`). Every query names tenant, workflow
 * and user. Gates and rate limit are final from C0 (`AI_ENABLED` false gives 404, viewer 403).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ApiError, parse } from '../http/errors';
import { aiRouteOptions, requireAiBuilder } from './ai';

const workflowSchema = z.object({ workflowId: z.string().min(1).max(64) });
const truncateSchema = workflowSchema.extend({ messageId: z.string().min(1).max(200) });
const acceptedSchema = workflowSchema.extend({ versionId: z.string().min(1).max(200) });

export function registerAiSessionRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  /** the workflow of this tenant, else 404 (another tenant's id is not found) */
  async function workflowOf(tenantId: string, workflowId: string): Promise<string> {
    const row = await ctx.repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    return row.id;
  }

  rest.post('/ai/sessions', aiRouteOptions('sessions'), async (request) => {
    const auth = requireAiBuilder(request, ctx, 'editor');
    const body = parse(workflowSchema, request.body);
    const workflowId = await workflowOf(auth.tenant.id, body.workflowId);
    const row = await ctx.repos.builderSessions.get(auth.tenant.id, workflowId, auth.user.id);
    return {
      data: {
        workflowId,
        messages: Array.isArray(row?.messages) ? row.messages : [],
        activeVersionCardId: row?.activeVersionCardId ?? null,
        resumeAfterRestoreMessageId: row?.resumeAfterRestoreMessageId ?? null,
      },
    };
  });

  rest.post('/ai/build/truncate-messages', aiRouteOptions('truncate'), async (request) => {
    const auth = requireAiBuilder(request, ctx, 'editor');
    const body = parse(truncateSchema, request.body);
    const workflowId = await workflowOf(auth.tenant.id, body.workflowId);
    const row = await ctx.repos.builderSessions.get(auth.tenant.id, workflowId, auth.user.id);
    const messages = Array.isArray(row?.messages) ? row.messages : [];
    const index = messages.findIndex((message) => message.id === body.messageId);
    if (!row || index < 0) throw ApiError.notFound('Message');
    const kept = messages.slice(0, index);
    const keeps = (id: string | null) =>
      id !== null && kept.some((message) => message.id === id) ? id : null;
    await ctx.repos.builderSessions.upsert(auth.tenant.id, workflowId, auth.user.id, {
      messages: kept,
      resumeAfterRestoreMessageId: body.messageId,
      activeVersionCardId: keeps(row.activeVersionCardId),
    });
    return { data: { ok: true as const } };
  });

  rest.post('/ai/build/clear-session', aiRouteOptions('clear'), async (request) => {
    const auth = requireAiBuilder(request, ctx, 'editor');
    const body = parse(workflowSchema, request.body);
    const workflowId = await workflowOf(auth.tenant.id, body.workflowId);
    await ctx.repos.builderSessions.clear(auth.tenant.id, workflowId, auth.user.id);
    return { data: { ok: true as const } };
  });

  rest.post('/ai/build/accepted-version', aiRouteOptions('accepted-version'), async (request) => {
    const auth = requireAiBuilder(request, ctx, 'editor');
    const body = parse(acceptedSchema, request.body);
    const workflowId = await workflowOf(auth.tenant.id, body.workflowId);
    const row = await ctx.repos.builderSessions.get(auth.tenant.id, workflowId, auth.user.id);
    const messages = Array.isArray(row?.messages) ? row.messages : [];
    const last = messages.at(-1);
    // no chat on this workflow (the draft came from somewhere else): nothing to tag
    if (!row || !last) return { data: { ok: true as const } };
    await ctx.repos.builderSessions.upsert(auth.tenant.id, workflowId, auth.user.id, {
      messages: [...messages.slice(0, -1), { ...last, versionId: body.versionId }],
      activeVersionCardId: last.id,
    });
    return { data: { ok: true as const } };
  });
}
