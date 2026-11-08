/**
 * Draft workflows of a thread (P5-70, lane L7): GET `/assistant/threads/:threadId/drafts/:draftId`
 * (viewer: the draft, its diff and the credential assignment), POST `.../accept` and `.../discard`
 * (editor; a person only, no tool calls them). Gates and rate limits are final from C0. Each answer is
 * in the `{ data }` envelope: the view, `{ workflowId, draft }`, and `{ ok: true }` for a discard. The
 * draft is read through the caller's own thread, so another user's or workspace's draft is 404.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clientIp } from '../http/auth';
import { parse } from '../http/errors';
import { assistantRouteOptions, requireAssistant } from './assistant';

const draftParams = z.object({
  threadId: z.string().min(1).max(64),
  draftId: z.string().min(1).max(64),
});

/** the accept body: an optional new name; nothing in it is a definition */
const acceptSchema = z.object({ name: z.string().trim().max(128).optional() });

export function registerAssistantDraftRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.get(
    '/assistant/threads/:threadId/drafts/:draftId',
    assistantRouteOptions('draft', 'read'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'viewer');
      const { threadId, draftId } = parse(draftParams, request.params);
      return { data: await ctx.assistantDrafts.get(auth, threadId, draftId) };
    },
  );

  rest.post(
    '/assistant/threads/:threadId/drafts/:draftId/accept',
    assistantRouteOptions('draft-accept', 'write'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'editor');
      const { threadId, draftId } = parse(draftParams, request.params);
      const body = parse(acceptSchema, request.body ?? {});
      const actor = { userId: auth.user.id, ip: clientIp(request) };
      return { data: await ctx.assistantDrafts.accept(auth, threadId, draftId, body, actor) };
    },
  );

  rest.post(
    '/assistant/threads/:threadId/drafts/:draftId/discard',
    assistantRouteOptions('draft-discard', 'write'),
    async (request) => {
      const { auth } = requireAssistant(request, ctx, 'editor');
      const { threadId, draftId } = parse(draftParams, request.params);
      await ctx.assistantDrafts.discard(auth, threadId, draftId);
      return { data: { ok: true as const } };
    },
  );
}
