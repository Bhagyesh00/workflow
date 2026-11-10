/**
 * P6-53 (C0): the demo's execution data redaction: `redactDemoExecution` judges GET /executions/:id (the policy of
 * the workflow, the workspace floor of `/settings/security`, `?redactExecutionData=false` to reveal), and the
 * who-can-reveal list. `redactDemoExecution` passes the answer through and the route answers 501 until L8 fills
 * them. L8 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

/**
 * GET /executions/:id's answer, redacted for the caller (items cleared, the error moved to `redactedError`,
 * `redactionInfo` set) or as is. `query.redactExecutionData === 'false'` asks to reveal.
 * stub (L8): a pass-through, so the answer is today's.
 */
export function redactDemoExecution<T extends object>(
  row: T,
  _query: Record<string, string>,
  _backend: MockBackend,
): T {
  return row;
}

export function registerRedactionRoutes(backend: MockBackend): void {
  // stub (L8): the who-can-reveal list (S1's server route, P6-32; the demo had none)
  backend.on('GET', '/roles/:slug/assignments/:projectId/members', () => notImplemented('L8'));
}
