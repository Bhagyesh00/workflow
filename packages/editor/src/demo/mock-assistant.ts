/**
 * Demo Assistant (P5-67, lane L2): the thread routes of `assistantApi` (api/endpoints.ts) on the in-memory
 * MockBackend and the scripted events of a turn. The demo has no model and no server stream: install.ts sets the
 * stream connector (`setAssistantStreamConnector`) to `demoAssistantStream(backend)`, which plays scripted events
 * for the thread instead of `GET /assistant/events/:threadId`.
 *
 * Routes L2 registers (all under /rest): POST and GET `/assistant/threads`, PATCH and DELETE
 * `/assistant/threads/:threadId`, GET `.../messages`, GET `.../status`, POST `/assistant/chat/:threadId`,
 * POST `/assistant/chat/:threadId/cancel`. C0 registers nothing.
 */
import type { AssistantStreamConnector } from '../api/assistant-stream';
import type { MockBackend } from './mock-backend';

/** P5-67: registers the demo Assistant's thread and chat routes (L2). C0: registers nothing. */
export function registerAssistantRoutes(_backend: MockBackend): void {}

/**
 * P5-67: the demo's thread stream for `backend`: scripted events after `afterId` until `signal` aborts (L2).
 * The factory does not throw; the stream itself is the L2 stub.
 */
export function demoAssistantStream(_backend: MockBackend): AssistantStreamConnector {
  return async () => {
    throw new Error('not implemented (L2)');
  };
}
