/**
 * Draft workflows of a thread (P5-70, lane L7): GET `/assistant/threads/:threadId/drafts/:draftId`
 * (viewer: the draft, its diff and the credential assignment), POST `.../accept` and `.../discard`
 * (editor; a person only, no tool calls them). Gates and rate limits are final from C0; the handlers
 * are L7's.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { assistantRouteOptions, requireAssistant } from './assistant';

function notImplemented(): never {
  throw new Error('not implemented (L7)');
}

export function registerAssistantDraftRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.get(
    '/assistant/threads/:threadId/drafts/:draftId',
    assistantRouteOptions('draft', 'read'),
    async (request) => {
      requireAssistant(request, ctx, 'viewer');
      return notImplemented();
    },
  );

  rest.post(
    '/assistant/threads/:threadId/drafts/:draftId/accept',
    assistantRouteOptions('draft-accept', 'write'),
    async (request) => {
      requireAssistant(request, ctx, 'editor');
      return notImplemented();
    },
  );

  rest.post(
    '/assistant/threads/:threadId/drafts/:draftId/discard',
    assistantRouteOptions('draft-discard', 'write'),
    async (request) => {
      requireAssistant(request, ctx, 'editor');
      return notImplemented();
    },
  );
}
