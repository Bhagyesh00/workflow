/**
 * POST /rest/assistant/confirm/:requestId (P5-68, lane L3): the person's answer to a card. Viewer; the
 * row's owner is checked in the query (tenant, user and id), so another user's or tenant's card is 404.
 * The gate and rate limit are final from C0. The body is the answer itself (`AssistantConfirmAnswer`, as
 * the editor sends it); the client sends an answer, never args: unknown keys are dropped and the tool
 * runs with the args the server stored with the card. Answers `{ data: { ok: true } }` at once; the
 * approved calls run in the settle that the answer starts.
 */
import type { AssistantConfirmAnswer } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clientIp } from '../http/auth';
import { parse } from '../http/errors';
import { assistantRouteOptions, requireAssistant } from './assistant';

const confirmParams = z.object({ requestId: z.string().min(1).max(64) });

/** one answer per card kind; anything else in the body (args above all) is dropped */
const answerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    approved: z.boolean(),
    scope: z.enum(['once', 'session']).optional(),
  }),
  z.object({
    kind: z.literal('questions'),
    answers: z.array(z.object({ id: z.string().min(1).max(64), answer: z.unknown() })).max(50),
    dismissed: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('domain'),
    action: z.enum(['allow_once', 'allow_domain', 'allow_all', 'deny']),
  }),
  z.object({
    kind: z.literal('credential'),
    credentialId: z.string().min(1).max(64).nullable(),
  }),
]);

export function registerAssistantConfirmRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/assistant/confirm/:requestId', assistantRouteOptions('confirm', 'write'), async (request) => {
    const { auth } = await requireAssistant(request, ctx, 'instanceAi:message');
    const { requestId } = parse(confirmParams, request.params);
    const answer = parse(answerSchema, request.body ?? {}) as AssistantConfirmAnswer;
    const actor = { userId: auth.user.id, ip: clientIp(request) };
    return { data: await ctx.assistantApprovals.confirm(auth, requestId, answer, actor) };
  });
}
