/**
 * Demo routes for annotation tags and PATCH /executions/:id (P3-09), registered by the MockBackend
 * constructor, plus the annotationTags / vote filter of GET /executions.
 *
 * C0 STUB: lane L9 writes them. Until then lists answer empty and writes answer 501.
 * Lane state lives in `backend.ext`; set `execution.annotation` on the stored executions.
 */
import type { MockBackend, StoredExecution } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerAnnotationRoutes(backend: MockBackend): void {
  backend.on('GET', '/annotation-tags', () => {
    backend.auth();
    return [];
  });
  backend.on('POST', '/annotation-tags', () => notImplemented('L9'));
  backend.on('PATCH', '/annotation-tags/:id', () => notImplemented('L9'));
  backend.on('DELETE', '/annotation-tags/:id', () => notImplemented('L9'));
  backend.on('PATCH', '/executions/:id', () => notImplemented('L9'));
}

/** GET /executions filters `annotationTags` (comma ids, all must match) and `vote` */
export function filterExecutionList(
  _backend: MockBackend,
  executions: StoredExecution[],
  _query: Record<string, string>,
): StoredExecution[] {
  return executions;
}
