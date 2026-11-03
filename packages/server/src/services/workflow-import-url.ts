/**
 * Import a workflow from a URL (P3-13): fetched through ctx.http (SSRF guard), 5 MB cap, 10 s timeout;
 * the URL is never logged nor echoed in errors.
 *
 * C0 STUB: lane L11 writes the body.
 */
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

export class WorkflowImportUrlService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workflow JSON found at the URL (not saved; the editor opens it as a new workflow) */
  async importFromUrl(_tenantId: string, _url: string): Promise<Record<string, unknown>> {
    throw new ApiError(501, 'not_implemented', 'not implemented (L11)');
  }
}
