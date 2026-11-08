/**
 * P5-09, P5-62: one builder turn, `POST /rest/ai/build`, read as NDJSON (one `BuilderChunk` per line,
 * n8n's chunk type names). The demo build has no server: it swaps the connector
 * (`setBuildStreamConnector` in demo/install.ts) for scripted chunks.
 */
import type { BuilderChunk, BuildRequest } from '@workflow/workflow';
import { ApiError, buildUrl, getCurrentTenant } from './client';

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

/** one NDJSON line as a chunk; a blank or broken line, or one without a `type`, is skipped */
function parseLine(line: string): BuilderChunk | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
      return value as BuilderChunk;
    }
  } catch {
    // not JSON: the stream goes on with the next line
  }
  return null;
}

/** the error envelope of an answer that never became a stream (404, 400, 403, 429 ...) */
async function failureOf(response: Response): Promise<ApiError> {
  type Envelope = { error?: { code?: string; message?: string; details?: unknown } };
  let body: Envelope | null = null;
  try {
    body = (await response.json()) as Envelope | null;
  } catch {
    body = null;
  }
  return new ApiError(
    response.status,
    body?.error?.code ?? `http_${response.status}`,
    body?.error?.message ?? `Request failed with status ${response.status}`,
    body?.error?.details,
  );
}

/** the server request of a turn: fetch with the tenant header, NDJSON lines, abort on `signal` */
async function serverStream(
  body: BuildRequest,
  onChunk: (chunk: BuilderChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
  };
  const tenantId = getCurrentTenant();
  if (tenantId) headers['x-tenant-id'] = tenantId;
  const response = await fetch(buildUrl('/ai/build'), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await failureOf(response);

  const emit = (line: string) => {
    const chunk = parseLine(line);
    if (chunk && !signal.aborted) onChunk(chunk);
  };
  const reader = response.body?.getReader();
  if (!reader) {
    for (const line of (await response.text()).split('\n')) emit(line);
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      emit(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  emit(buffer);
}

/** Runs one builder turn: through the connector when one is set, else against the server. */
export function streamBuild(
  body: BuildRequest,
  onChunk: (chunk: BuilderChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  return (connector ?? serverStream)(body, onChunk, signal);
}
