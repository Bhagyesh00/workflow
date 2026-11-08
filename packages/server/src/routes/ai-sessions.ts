/**
 * /rest/ai session routes (P5-66, L6), all editor: POST `/ai/sessions` (this workflow's messages for
 * this user only), `/ai/build/truncate-messages` (removes a message and the later ones, records
 * `resume_after_restore_message_id`), `/ai/build/clear-session`, `/ai/build/accepted-version` (writes
 * `active_version_card_id`, tags the last message with `versionId`). Every query names tenant, workflow
 * and user. Gates and rate limit are final from C0 (`AI_ENABLED` false gives 404, viewer 403).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { aiRouteOptions, requireAiBuilder } from './ai';

export function registerAiSessionRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/ai/sessions', aiRouteOptions('sessions'), async (request) => {
    requireAiBuilder(request, ctx, 'editor');
    throw new Error('not implemented (L6)');
  });

  rest.post('/ai/build/truncate-messages', aiRouteOptions('truncate'), async (request) => {
    requireAiBuilder(request, ctx, 'editor');
    throw new Error('not implemented (L6)');
  });

  rest.post('/ai/build/clear-session', aiRouteOptions('clear'), async (request) => {
    requireAiBuilder(request, ctx, 'editor');
    throw new Error('not implemented (L6)');
  });

  rest.post('/ai/build/accepted-version', aiRouteOptions('accepted-version'), async (request) => {
    requireAiBuilder(request, ctx, 'editor');
    throw new Error('not implemented (L6)');
  });
}
