/**
 * Demo AI workflow builder (P5-09, P5-62, lane L2): the builder's REST routes on the in-memory MockBackend and
 * the scripted chunks of a build turn. The demo has no model: install.ts sets a build stream connector
 * (`setBuildStreamConnector`) that plays `demoBuildChunks(body)` instead of `POST /ai/build`.
 *
 * C0 stub: the routes are registered with the paths of `aiApi` (api/endpoints.ts) and answer
 * `not implemented (L2)`; `demoBuildChunks` throws the same. L2 fills both: scripted chunks for a build, a plan
 * (plan mode questions and plan) and a web fetch approval.
 */
import type { BuilderChunk, BuildRequest } from '@workflow/workflow';
import type { MockBackend } from './mock-backend';

function notImplemented(): never {
  throw new Error('not implemented (L2)');
}

/** The builder's REST routes (`aiApi`): chat history, truncate, clear, accepted version and the usage setting. */
export function registerAiRoutes(backend: MockBackend): void {
  backend.on('POST', '/ai/sessions', notImplemented);
  backend.on('POST', '/ai/build/truncate-messages', notImplemented);
  backend.on('POST', '/ai/build/clear-session', notImplemented);
  backend.on('POST', '/ai/build/accepted-version', notImplemented);
  backend.on('POST', '/ai/usage-settings', notImplemented);
}

/** The chunks one demo build turn streams for `body` (what the server's NDJSON would carry). */
export function demoBuildChunks(_body: BuildRequest): BuilderChunk[] {
  throw new Error('not implemented (L2)');
}
