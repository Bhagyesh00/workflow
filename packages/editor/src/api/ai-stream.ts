/**
 * P5-09, P5-62: one builder turn, `POST /rest/ai/build`, read as NDJSON (one `BuilderChunk` per line,
 * n8n's chunk type names). The demo build has no server: it swaps the connector
 * (`setBuildStreamConnector` in demo/install.ts) for scripted chunks. L2 fills the real request.
 */
import type { BuilderChunk, BuildRequest } from '@workflow/workflow';

/** sends one build request and calls `onChunk` for each chunk until the stream ends or `signal` aborts */
export type BuildStreamConnector = (
  body: BuildRequest,
  onChunk: (chunk: BuilderChunk) => void,
  signal: AbortSignal,
) => Promise<void>;

let connector: BuildStreamConnector | null = null;

/** Replace the stream (the demo's seam); `null` goes back to the server request. */
export function setBuildStreamConnector(next: BuildStreamConnector | null): void {
  connector = next;
}

/** the connector set last, or null for the server request */
export function getBuildStreamConnector(): BuildStreamConnector | null {
  return connector;
}

/** the server request of a turn (L2): fetch with the tenant header, NDJSON lines, abort on `signal` */
async function serverStream(
  _body: BuildRequest,
  _onChunk: (chunk: BuilderChunk) => void,
  _signal: AbortSignal,
): Promise<void> {
  throw new Error('not implemented (L2)');
}

/** Runs one builder turn: through the connector when one is set, else against the server. */
export function streamBuild(
  body: BuildRequest,
  onChunk: (chunk: BuilderChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  return (connector ?? serverStream)(body, onChunk, signal);
}
