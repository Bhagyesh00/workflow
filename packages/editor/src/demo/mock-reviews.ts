/**
 * Demo routes for workflow reviews and the inbox (P3-19), registered by the MockBackend
 * constructor: /workflow-reviews (list, eligible-reviewers, create, get, update-version, decision,
 * activity, comments), /inbox and /inbox/summary. Changes emit `workflowReviewChanged`.
 *
 * C0 STUB: lane L15 writes them. Until then lists answer empty, the summary zero, the rest 501.
 * Lane state lives in `backend.ext`.
 */
import type { MockBackend } from './mock-backend';
import { listResult, notImplemented } from './mock-http';

export function registerReviewRoutes(backend: MockBackend): void {
  backend.on('GET', '/workflow-reviews', () => {
    backend.auth();
    return listResult({ data: [], nextCursor: null });
  });
  backend.on('GET', '/workflow-reviews/eligible-reviewers', () => {
    backend.auth();
    return [];
  });
  backend.on('POST', '/workflow-reviews', () => notImplemented('L15'));
  backend.on('GET', '/workflow-reviews/:id', () => notImplemented('L15'));
  backend.on('POST', '/workflow-reviews/:id/update-version', () => notImplemented('L15'));
  backend.on('POST', '/workflow-reviews/:id/decision', () => notImplemented('L15'));
  backend.on('GET', '/workflow-reviews/:id/activity', () => notImplemented('L15'));
  backend.on('POST', '/workflow-reviews/:id/comments', () => notImplemented('L15'));
  backend.on('GET', '/inbox', () => {
    backend.auth();
    return listResult({ data: [], nextCursor: null });
  });
  backend.on('GET', '/inbox/summary', () => {
    backend.auth();
    return { toReview: 0, mine: 0 };
  });
}
