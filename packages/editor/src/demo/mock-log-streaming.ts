/**
 * P6-64 (C0, stub (L8)): the demo's log streaming routes, the REST paths of the server's routes/log-streaming.ts
 * as the editor's `logStreamingApi` calls them (api/endpoints.ts). Every path answers 501 until L8 fills it.
 * Rules L8 keeps, as the server: GET `/eventbus/destination` lists (`eventBusDestination:list`) or, with `?id=`,
 * answers one destination (`:read`); POST saves (`:create`, or `:update` when the body has an id); DELETE and
 * POST `/eventbus/testmessage` take `?id=`; a saved secret comes back blank. State lives per workspace in the
 * registering backend.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

const LANE = 'L8';

/** every log streaming REST path, method first */
const LOG_STREAMING_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/eventbus/eventnames'],
  ['GET', '/eventbus/destination'],
  ['POST', '/eventbus/destination'],
  ['DELETE', '/eventbus/destination'],
  ['POST', '/eventbus/testmessage'],
];

export function registerLogStreamingRoutes(backend: MockBackend): void {
  // stub (L8): each route answers 501 until L8 writes it
  for (const [method, path] of LOG_STREAMING_ROUTES) backend.on(method, path, () => notImplemented(LANE));
}
