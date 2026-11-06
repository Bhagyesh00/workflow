/**
 * Demo routes for data tables, registered by the MockBackend constructor. Stubs: L6 (P4-05) writes
 * them with the server's rules. `dataTableName`, `searchDataTables` and `simulateDataTableNode` have
 * no backend argument, so L6 keeps the state here and registerDataTableRoutes starts it fresh.
 */
import type { Item, ListSearchResult, WorkflowNode } from '@workflow/workflow';
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

/** every route of `dataTablesApi`, in match order */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/data-tables'],
  ['GET', '/data-tables/limits'],
  ['POST', '/data-tables'],
  ['POST', '/data-tables/csv/preview'],
  ['GET', '/data-tables/:id'],
  ['PATCH', '/data-tables/:id'],
  ['DELETE', '/data-tables/:id'],
  ['GET', '/data-tables/:id/dependencies'],
  ['GET', '/data-tables/:id/columns'],
  ['POST', '/data-tables/:id/columns'],
  ['DELETE', '/data-tables/:id/columns/:columnId'],
  ['PATCH', '/data-tables/:id/columns/:columnId/move'],
  ['PATCH', '/data-tables/:id/columns/:columnId/rename'],
  ['GET', '/data-tables/:id/rows'],
  ['POST', '/data-tables/:id/insert'],
  ['POST', '/data-tables/:id/upsert'],
  ['PATCH', '/data-tables/:id/rows'],
  ['DELETE', '/data-tables/:id/rows/clear'],
  ['DELETE', '/data-tables/:id/rows'],
  ['GET', '/data-tables/:id/download-csv'],
  ['POST', '/data-tables/:id/import-csv'],
];

export function registerDataTableRoutes(backend: MockBackend): void {
  for (const [method, path] of ROUTES) backend.on(method, path, () => notImplemented('L6'));
}

/** the name of a table, undefined when there is none */
export function dataTableName(_id: string): string | undefined {
  return undefined;
}

/** the list mode of the Data Table node's locator (method `tableSearch`) */
export function searchDataTables(_filter: string): ListSearchResult {
  return { results: [] };
}

/** what a Data Table node does in the demo run */
export function simulateDataTableNode(_node: WorkflowNode, _items: Item[]): Item[][] {
  throw new Error('not implemented (L6)');
}
