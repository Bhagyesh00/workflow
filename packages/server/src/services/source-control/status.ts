/**
 * P6-74 (L3): what differs between the workspace and the work folder. A local change is `workflows.version_id`
 * differing from the map's local version, a remote change the file's `versionId` differing from the map's git
 * version; also parent folder, description and owner. A modified file is a conflict, as n8n; a remote delete is a
 * conflict on pull; `preferLocalVersion` as n8n; `scope` filters to a project set.
 * stub (L3): both throw.
 */
import type { SourceControlledFile, SourceControlledFileType } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SyncIdMap } from './id-map';
import type { ParsedFile } from './import-schemas';

/** one local resource as status compares it (local ids) */
export interface LocalResource {
  type: SourceControlledFileType;
  id: string;
  name: string;
  /** workflows: `workflows.version_id`; the other kinds a hash of what is exported */
  versionId: string;
  updatedAt: string;
  projectId: string | null;
  parentFolderId?: string | null;
  description?: string | null;
  isPublished?: boolean;
}

/** the workspace side of a status, in `scope` */
export interface LocalSnapshot {
  tenantId: string;
  scope: 'all' | Set<string>;
  resources: LocalResource[];
}

/** stub (L3) */
export function localSnapshot(
  _deps: ServiceDeps,
  _tenantId: string,
  _scope: 'all' | Set<string>,
): Promise<LocalSnapshot> {
  throw new Error('not implemented (L3)');
}

/** stub (L3) */
export function computeStatus(_input: {
  local: LocalSnapshot;
  remote: Map<string, ParsedFile>;
  map: SyncIdMap;
  direction: 'push' | 'pull';
  preferLocalVersion?: boolean;
}): SourceControlledFile[] {
  throw new Error('not implemented (L3)');
}
