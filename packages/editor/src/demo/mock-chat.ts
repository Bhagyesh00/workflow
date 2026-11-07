/**
 * Demo chat (P5-59, lane L5): the canvas chat panel's transport on the in-memory MockBackend.
 *
 * `demoChatFetch` answers the panel's POSTs to a test chat URL (`/webhook-test/<slug>/<id>/chat` with the
 * `x-chat-test-token` header that POST /workflows/:id/listen-test-webhook returned): it finds the listen by
 * its token (`backend.testListenByChatToken`), starts the simulated run with the chat item
 * (`backend.receiveTestWebhook(workflowId, [item])`, which also emits `testWebhookReceived`) and answers with
 * NDJSON frames (`ChatFrame` of @workflow/workflow). install.ts passes it to `setChatFetch`.
 */
import type { MockBackend } from './mock-backend';

/** Routes the demo chat needs on the REST transport; C0 registers none (L5 adds them here, or none). */
export function registerChatRoutes(_backend: MockBackend): void {
  // stub (L5): MockBackend's constructor calls this, so it must not throw
}

/** The `fetch` the chat panel uses in the demo (and in the editor tests that set it). */
export function demoChatFetch(_backend: MockBackend): typeof fetch {
  // stub (L5): install.ts calls this at start-up, so only a request through it fails
  return async () => {
    throw new Error('not implemented (L5)');
  };
}
