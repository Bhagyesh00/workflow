/**
 * P6-85 (C0): the demo's bulk stop and delete of executions, in the list filter form of GET /executions (ids, or
 * the filter with `filterByIds: false`). The routes answer 501 until L17 fills them; L17 widens the list filter in
 * mock-annotations.ts `filterExecutionList`. L17 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerExecutionBulkRoutes(backend: MockBackend): void {
  // stub (L17)
  backend.on('POST', '/executions/stopMany', () => notImplemented('L17'));
  backend.on('POST', '/executions/delete', () => notImplemented('L17'));
}
