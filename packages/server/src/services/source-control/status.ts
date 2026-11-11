/**
 * P6-74 (L3): what differs between the workspace and the work folder. A local change is `workflows.version_id`
 * differing from the map's local version, a remote change the file's `versionId` differing from the map's git
 * version (the other kinds use a content hash in the same two places); also parent folder, description and owner of a
 * workflow. A file changed on both sides is a conflict, a remote delete of a synced resource is a conflict on pull;
 * `preferLocalVersion` keeps the local side (no conflict on push, a locally changed file is left out of a pull);
 * `scope` filters to a project set.
 *
 * Rows: a resource only here is `created` (push), a synced one gone from the folder is `deleted` on pull, a synced
 * one gone from the workspace is `deleted` on push, a file only in the folder is `created` on pull, a difference is
 * `modified`. The ids in a row are git ids and `file` is the work folder path.
 */
import { pathFor, type SourceControlledFile, type SourceControlledFileType } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SyncResourceType } from '../../db/schema';
import type { SyncIdMap } from './id-map';
import type {
  CredentialStubFile,
  DataTableFile,
  FileOwner,
  ParsedFile,
  ProjectFile,
  WorkflowFile,
} from './import-schemas';
import { contentVersion, type LocalFile, readLocalFiles } from './serialize';

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
  /** the owning project's kind and name (for the row's `owner`) */
  projectType?: 'personal' | 'team';
  projectName?: string;
  /** a personal project's owner email, for the owner comparison of a workflow */
  ownerEmail?: string | null;
  /** the names of the folders above a workflow, outermost first */
  folderPath?: string[];
}

/** the workspace side of a status, in `scope` */
export interface LocalSnapshot {
  tenantId: string;
  scope: 'all' | Set<string>;
  resources: LocalResource[];
}

const SINGLE_TYPES: Array<'variables' | 'tags' | 'folders'> = ['variables', 'tags', 'folders'];
const RESOURCE_TYPES: SourceControlledFileType[] = ['project', 'credential', 'datatable', 'workflow'];
const ORDER: SourceControlledFileType[] = [
  'project',
  'folders',
  'credential',
  'datatable',
  'workflow',
  'tags',
  'variables',
];
const EPOCH = new Date(0).toISOString();

const mapType = (type: SourceControlledFileType): SyncResourceType => {
  switch (type) {
    case 'variables':
      return 'variable';
    case 'tags':
      return 'tag';
    case 'folders':
      return 'folder';
    default:
      return type;
  }
};

/** the version of a remote file, as the map's git version records it: a workflow's `versionId`, else a content hash */
export function fileVersionId(file: ParsedFile): string {
  return file.type === 'workflow' ? file.data.versionId : contentVersion(file.type, file.data);
}

function resourceOf(file: LocalFile, snapshot: Awaited<ReturnType<typeof readLocalFiles>>): LocalResource {
  const base = { updatedAt: file.updatedAt };
  if (file.type === 'variables' || file.type === 'tags' || file.type === 'folders') {
    return {
      ...base,
      type: file.type,
      id: file.type,
      name: file.type,
      versionId: contentVersion(file.type, file.data),
      projectId: null,
    };
  }
  const project = snapshot.projects.get(file.projectId);
  const info = {
    projectType: project?.type,
    projectName: project?.name,
    ownerEmail: project?.ownerUserId ? (snapshot.emails.get(project.ownerUserId) ?? null) : null,
  };
  if (file.type === 'workflow') {
    const names: string[] = [];
    const byId = new Map(snapshot.folders.map((f) => [f.id, f]));
    let current = file.row.folderId ? byId.get(file.row.folderId) : undefined;
    for (let depth = 0; current && depth < 64; depth++) {
      names.unshift(current.name);
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return {
      ...base,
      ...info,
      type: 'workflow',
      id: file.id,
      name: file.data.name,
      versionId: file.data.versionId,
      projectId: file.projectId,
      parentFolderId: file.data.parentFolderId,
      description: file.data.description,
      isPublished: file.row.publishedVersionId !== null,
      folderPath: names,
    };
  }
  return {
    ...base,
    ...info,
    type: file.type,
    id: file.id,
    name: file.data.name,
    versionId: contentVersion(file.type, file.data),
    projectId: file.projectId,
  };
}

/** the workspace side in `scope`: one row per resource, ids local, versions as the map records them */
export async function localSnapshot(
  deps: ServiceDeps,
  tenantId: string,
  scope: 'all' | Set<string>,
): Promise<LocalSnapshot> {
  const local = await readLocalFiles(deps, tenantId, scope);
  return { tenantId, scope, resources: local.files.map((file) => resourceOf(file, local)) };
}

type Entry = ReturnType<SyncIdMap['entryForLocal']>;

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');

/** a remote file's owning project as a local id: the mapped team project, else the git id itself */
function remoteProjectOf(owner: FileOwner | null | undefined, map: SyncIdMap): string | null {
  if (owner?.type !== 'team') return null;
  return map.localIdFor('project', owner.teamId) ?? owner.teamId;
}

function remoteOwnerRow(
  owner: FileOwner | null | undefined,
  map: SyncIdMap,
): SourceControlledFile['owner'] | undefined {
  if (!owner) return undefined;
  if (owner.type === 'team') {
    return {
      type: 'team',
      projectId: remoteProjectOf(owner, map) ?? owner.teamId,
      projectName: owner.teamName,
    };
  }
  return { type: 'personal', projectId: '', projectName: owner.personalEmail };
}

/** the owner a workflow file names, compared with the local one (n8n compares it too) */
function ownerDiffers(local: LocalResource, file: WorkflowFile, map: SyncIdMap): boolean {
  const owner = file.owner;
  // a file with no owner says nothing about it
  if (!owner) return false;
  if (owner.type === 'team') {
    return !(
      local.projectType === 'team' &&
      local.projectId &&
      map.gitIdFor('project', local.projectId) === owner.teamId
    );
  }
  return !(
    local.projectType === 'personal' &&
    (local.ownerEmail ?? '').toLowerCase() === owner.personalEmail.toLowerCase()
  );
}

function metaDiffers(local: LocalResource, file: WorkflowFile, map: SyncIdMap): boolean {
  const localParent = local.parentFolderId ? map.gitIdFor('folder', local.parentFolderId) : null;
  return (
    !sameText(localParent, file.parentFolderId) ||
    !sameText(local.description, file.description) ||
    ownerDiffers(local, file, map)
  );
}

/** `scope` against a remote file's owner (a personal project is never in a set) */
function remoteInScope(
  scope: 'all' | Set<string>,
  owner: FileOwner | null | undefined,
  map: SyncIdMap,
): boolean {
  if (scope === 'all') return true;
  const projectId = remoteProjectOf(owner, map);
  return projectId !== null && scope.has(projectId);
}

function remoteName(file: ParsedFile): string {
  switch (file.type) {
    case 'workflow':
    case 'credential':
    case 'datatable':
    case 'project':
      return file.data.name;
    default:
      return file.type;
  }
}

function remoteOwnerOf(file: ParsedFile): FileOwner | null {
  switch (file.type) {
    case 'workflow':
      return (file.data as WorkflowFile).owner;
    case 'credential':
      return (file.data as CredentialStubFile).owner;
    case 'project':
      return (file.data as ProjectFile).owner;
    case 'datatable':
      return { type: 'team', teamId: (file.data as DataTableFile).projectId, teamName: '' };
    default:
      return null;
  }
}

/**
 * Compares the workspace with the remote files. `remote` holds the parsed files by path. Every row names a git id
 * and the work folder path. See the head of the file for the rows.
 */
export function computeStatus(input: {
  local: LocalSnapshot;
  remote: Map<string, ParsedFile>;
  map: SyncIdMap;
  direction: 'push' | 'pull';
  preferLocalVersion?: boolean;
}): SourceControlledFile[] {
  const { local, remote, map, direction } = input;
  const preferLocal = input.preferLocalVersion === true;
  const rows: SourceControlledFile[] = [];

  const remoteByKey = new Map<string, ParsedFile>();
  for (const file of remote.values()) {
    if ('id' in file) remoteByKey.set(`${file.type}:${file.id.toLowerCase()}`, file);
  }

  const push = (row: SourceControlledFile) => rows.push(row);
  const ownerRowOf = (resource: LocalResource): SourceControlledFile['owner'] | undefined =>
    resource.projectType && resource.projectId
      ? {
          type: resource.projectType,
          projectId: resource.projectId,
          projectName: resource.projectName ?? '',
        }
      : undefined;

  // resources with a file of their own
  const seen = new Set<string>();
  for (const resource of local.resources) {
    if (!RESOURCE_TYPES.includes(resource.type)) continue;
    const gitId = map.gitIdFor(mapType(resource.type), resource.id);
    const key = `${resource.type}:${gitId}`;
    seen.add(key);
    const file = remoteByKey.get(key);
    const path = pathFor(resource.type, gitId);
    const entry: Entry = map.entryForLocal(mapType(resource.type), resource.id);
    const common = {
      file: path,
      id: gitId,
      name: resource.name,
      type: resource.type,
      updatedAt: resource.updatedAt,
      owner: ownerRowOf(resource),
      ...(resource.type === 'workflow'
        ? { isLocalPublished: resource.isPublished === true, folderPath: resource.folderPath }
        : {}),
    };
    if (!file) {
      if (direction === 'push') {
        push({ ...common, status: 'created', location: 'local', conflict: false });
      } else if (entry && !preferLocal) {
        // synced once and gone from the folder: the remote deleted it
        push({ ...common, status: 'deleted', location: 'remote', conflict: true });
      }
      continue;
    }
    const remoteVersion = fileVersionId(file);
    let localChanged: boolean;
    let remoteChanged: boolean;
    if (entry && entry.localVersionId !== null && entry.gitVersionId !== null) {
      localChanged = resource.versionId !== entry.localVersionId;
      remoteChanged = remoteVersion !== entry.gitVersionId;
    } else {
      // no baseline: the same content (in local ids) is in sync, anything else changed on both sides
      const same =
        file.type === 'workflow'
          ? file.data.versionId === resource.versionId
          : contentVersion(file.type, map.rewriteDefinition(file.data, 'toLocal')) === resource.versionId;
      localChanged = !same;
      remoteChanged = !same;
    }
    if (!localChanged && !remoteChanged && resource.type === 'workflow' && file.type === 'workflow') {
      if (metaDiffers(resource, file.data, map)) {
        if (direction === 'push') localChanged = true;
        else remoteChanged = true;
      }
    }
    if (!localChanged && !remoteChanged) continue;
    if (direction === 'push') {
      push({ ...common, status: 'modified', location: 'local', conflict: remoteChanged && !preferLocal });
    } else if (remoteChanged) {
      push({ ...common, status: 'modified', location: 'remote', conflict: localChanged && !preferLocal });
    } else if (!preferLocal) {
      // only the workspace changed: a pull would not touch it, but n8n reports it as a conflict
      push({ ...common, status: 'modified', location: 'local', conflict: true });
    }
  }

  // files with no workspace row: new on the remote (pull) or deleted in the workspace (push)
  for (const file of remote.values()) {
    if (!('id' in file)) continue;
    const key = `${file.type}:${file.id.toLowerCase()}`;
    if (seen.has(key) || !RESOURCE_TYPES.includes(file.type)) continue;
    if (!remoteInScope(local.scope, remoteOwnerOf(file), map)) continue;
    const entry = map.entryForGit(mapType(file.type), file.id);
    const owner = remoteOwnerOf(file);
    const common = {
      file: file.path,
      id: file.id,
      name: remoteName(file),
      type: file.type,
      updatedAt: EPOCH,
      owner: remoteOwnerRow(owner, map),
    } as const;
    if (direction === 'pull') {
      push({ ...common, status: 'created', location: 'remote', conflict: false });
    } else if (entry) {
      push({ ...common, status: 'deleted', location: 'local', conflict: false });
    }
  }

  // the single files: variables, tags, folders (only when the scope holds the whole workspace)
  if (local.scope === 'all') {
    for (const type of SINGLE_TYPES) {
      const resource = local.resources.find((r) => r.type === type);
      if (!resource) continue;
      const path = pathFor(type);
      const file = remote.get(path);
      const common = {
        file: path,
        id: type,
        name: type,
        type,
        updatedAt: resource.updatedAt,
      } as const;
      const emptyHash = contentVersion(
        type,
        type === 'variables' ? [] : type === 'tags' ? { tags: [], mappings: [] } : { folders: [] },
      );
      if (!file) {
        if (direction === 'push' && resource.versionId !== emptyHash) {
          push({ ...common, status: 'created', location: 'local', conflict: false });
        }
        continue;
      }
      const remoteHash = contentVersion(type, map.rewriteDefinition(file.data, 'toLocal'));
      if (remoteHash === resource.versionId) continue;
      if (direction === 'push') {
        push({ ...common, status: 'modified', location: 'local', conflict: false });
      } else if (!preferLocal) {
        push({ ...common, status: 'modified', location: 'remote', conflict: false });
      }
    }
  }

  return rows.sort(
    (a, b) =>
      ORDER.indexOf(a.type) - ORDER.indexOf(b.type) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
