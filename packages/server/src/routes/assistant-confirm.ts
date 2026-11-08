/**
 * POST /rest/assistant/confirm/:requestId (P5-68, lane L3): the person's answer to a card. Viewer; the
 * row's owner is checked in the query (tenant, user and id), so another user's or tenant's card is 404.
 * The gate and rate limit are final from C0; the handler is L3's. The client sends an answer, never args.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { assistantRouteOptions, requireAssistant } from './assistant';

export function registerAssistantConfirmRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/assistant/confirm/:requestId', assistantRouteOptions('confirm', 'write'), async (request) => {
    requireAssistant(request, ctx, 'viewer');
    throw new Error('not implemented (L3)');
  });
}
