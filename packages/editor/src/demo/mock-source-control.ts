/**
 * P6-76 (C0, stub (L6)): the demo's Git environment routes, the REST paths of the server's
 * routes/source-control.ts and routes/source-control-sync.ts. Every path answers 501 until L6 fills it; L6's
 * PATCH `/source-control/preferences` with `branchReadOnly` calls `backend.setDemoProtected` (C0f), which
 * GET `/settings` answers as `sourceControl.readOnly`.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

const LANE = 'L6';

/** every `/source-control/*` REST path, method first */
const SOURCE_CONTROL_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/source-control/preferences'],
  ['POST', '/source-control/preferences'],
  ['PATCH', '/source-control/preferences'],
  ['POST', '/source-control/disconnect'],
  ['GET', '/source-control/get-branches'],
  ['POST', '/source-control/generate-key-pair'],
  ['GET', '/source-control/get-status'],
  ['GET', '/source-control/status'],
  ['POST', '/source-control/push-workfolder'],
  ['POST', '/source-control/pull-workfolder'],
  ['GET', '/source-control/remote-content/:type/:id'],
];

export function registerSourceControlRoutes(backend: MockBackend): void {
  // stub (L6): each route answers 501 until L6 writes it
  for (const [method, path] of SOURCE_CONTROL_ROUTES) backend.on(method, path, () => notImplemented(LANE));
}
