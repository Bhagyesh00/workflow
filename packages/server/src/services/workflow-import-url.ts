/**
 * Import a workflow from a URL (P3-13): fetched through ctx.http (SSRF guard, redirects checked),
 * 5 MB cap, 10 s timeout; the URL is never logged nor echoed in errors. The workflow is not saved:
 * the editor pastes it into the open workflow.
 */
import { SsrfBlockedError } from '@workflow/core';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const NOT_JSON = 'The URL does not point to valid JSON file!';
const NOT_WORKFLOW = 'The data in the file does not seem to be a workflow JSON file!';

export class WorkflowImportUrlService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workflow JSON found at the URL (not saved; the editor opens it as a new workflow) */
  async importFromUrl(_tenantId: string, url: string): Promise<Record<string, unknown>> {
    const text = await this.fetchText(url);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw ApiError.badRequest(NOT_JSON);
    }
    if (!isWorkflowJson(data)) throw ApiError.badRequest(NOT_WORKFLOW);
    return data;
  }

  private async fetchText(url: string): Promise<string> {
    const { http } = this.deps.context();
    try {
      const stream = (await http.request({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: TIMEOUT_MS,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      })) as AsyncIterable<Uint8Array>;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.byteLength;
        if (total > MAX_BYTES) throw new Error('too large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      // the guard's message names only the host and address; every other failure hides the URL
      if (error instanceof SsrfBlockedError) throw ApiError.badRequest(error.message);
      throw ApiError.badRequest(NOT_JSON);
    }
  }
}

function isWorkflowJson(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const { nodes, connections } = data as { nodes?: unknown; connections?: unknown };
  return (
    Array.isArray(nodes) && !!connections && typeof connections === 'object' && !Array.isArray(connections)
  );
}
