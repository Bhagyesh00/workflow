/**
 * Folders (P3-07): create, rename, tags, move (no cycles), delete with transfer, counts.
 *
 * C0 STUB: lane L8 writes the bodies (and may add methods).
 */
import type { ServiceDeps } from '../context';

export class FolderService {
  constructor(readonly deps: ServiceDeps) {}

  async list(
    _tenantId: string,
    _query: Record<string, unknown>,
  ): Promise<{ data: unknown[]; nextCursor: string | null }> {
    throw new Error('not implemented (L8)');
  }
}
