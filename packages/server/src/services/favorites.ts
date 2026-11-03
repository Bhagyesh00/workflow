/**
 * Per-user favorites (P3-07).
 *
 * C0 STUB: lane L8 writes the bodies (and may add methods).
 */
import type { ServiceDeps } from '../context';
import type { FavoriteResourceType } from '../repositories';

export class FavoriteService {
  constructor(readonly deps: ServiceDeps) {}

  /** called when a workflow or folder is deleted, BEFORE its row goes (C0: no-op) */
  async removeForResource(
    _tenantId: string,
    _type: FavoriteResourceType,
    _resourceId: string,
  ): Promise<void> {}
}
