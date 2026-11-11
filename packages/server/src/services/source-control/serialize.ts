/**
 * P6-74 (L3): the export side. `exportFiles` writes the tenant's resources in `scope` ('all' or a set of project
 * ids, from `pushableProjects`) as n8n's work folder files, by path, ids rewritten to git ids through the map.
 * `sanitizeCredentialData` keeps no secret: strings emptied unless an expression, `oauthTokenData` and nulls dropped,
 * numbers and booleans kept.
 * stub (L3): both throw.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SyncIdMap } from './id-map';

/** stub (L3) */
export function exportFiles(
  _deps: ServiceDeps,
  _tenantId: string,
  _scope: 'all' | Set<string>,
  _map: SyncIdMap,
): Promise<Map<string, Uint8Array>> {
  throw new Error('not implemented (L3)');
}

/** stub (L3) */
export function sanitizeCredentialData(_data: DataObject): DataObject {
  throw new Error('not implemented (L3)');
}
