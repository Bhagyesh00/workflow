/**
 * P6-74 (L3): the project a pulled file lands in. A personal owner maps by email to that member's personal project
 * in this tenant (the tenant's memberships, `repos.projects.getPersonal`); an email of no member falls back to the
 * puller's personal project; a team owner maps through the id map, the project created when missing.
 * stub (L3): throws.
 */
import type { ServiceDeps } from '../../context';
import type { SyncIdMap } from './id-map';
import type { FileOwner } from './import-schemas';

/** stub (L3): returns a project id of `tenantId` */
export function resolveOwner(
  _deps: ServiceDeps,
  _tenantId: string,
  _owner: FileOwner,
  _puller: { userId: string },
  _map: SyncIdMap,
): Promise<string> {
  throw new Error('not implemented (L3)');
}
