/**
 * P6-07 (L4): the push steps (internal to `SourceControlSyncService.push`): `assertTenantWritable(..., 'push')`
 * first, then under the lease: the shallow fetch, the caller's own status within `pushableProjects`, the picked files
 * only (GHSA-hvrx-jc5j-pg3w: the client names id and type, every path comes from that status; a name outside it is
 * refused), conflicts without `force` give 409 with the list, one commit on the fetched head holding the remote's
 * files with only the picked ones changed (message trimmed, 1 to 1000, default "Updated Workfolder"), then the push
 * (`force` as given, as n8n). The lease is extended after the fetch, before the commit and before the push. The id
 * map is written after the push, outside any Git call. A caller with no pushable project is refused before any
 * lease or fetch. A push limited to some projects carries no whole single file, so the folders (with their parent
 * chain) and the tags of the picked workflows are merged into the remote's folders.json and tags.json, every other
 * entry kept as fetched.
 */
import {
  type PushResult,
  type PushWorkFolderBody,
  SOURCE_CONTROL_DEFAULTS,
  type SourceControlledFile,
  type SourceControlledFileType,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SyncResourceType } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { assertTenantWritable } from '../protected';
import { SyncIdMap } from './id-map';
import { type FoldersFile, type ParsedFile, parseFile, type TagsFile } from './import-schemas';
import { pushableProjects } from './scope';
import { exportFiles } from './serialize';
import { fileVersionId, localSnapshot } from './status';
import { readBranch, rowKey, statusRows, withLease, withSession } from './sync';

/** the types with a file of their own (and a row in the id map with versions) */
const RESOURCE_TYPES: ReadonlySet<SourceControlledFileType> = new Set([
  'workflow',
  'credential',
  'datatable',
  'project',
]);

const MAX_MESSAGE = 1000;

/**
 * a picked file the caller's own push status does not hold (an unknown name or another project's: one text for
 * both, so the answer never tells whether the file exists). REST answers 400, as n8n's REST controller.
 */
export class PushFileNotInChangesError extends ApiError {
  constructor() {
    super(400, 'bad_request', 'A picked file is not part of the changes.');
    this.name = 'PushFileNotInChangesError';
  }
}

function commitMessageOf(body: PushWorkFolderBody): string {
  const message = (body.commitMessage ?? '').trim() || SOURCE_CONTROL_DEFAULTS.commitMessage;
  if (message.length > MAX_MESSAGE) {
    throw ApiError.badRequest(`The commit message is longer than ${MAX_MESSAGE} characters.`);
  }
  return message;
}

/** the rows the client named, each found in the server's own status; any other name is refused */
function pickRows(
  rows: SourceControlledFile[],
  names: PushWorkFolderBody['fileNames'],
): SourceControlledFile[] {
  if (!names.length) throw ApiError.badRequest('Pick at least one file to push.');
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  const picked = new Map<string, SourceControlledFile>();
  for (const name of names) {
    const key = rowKey({ type: name.type, id: String(name.id) });
    const row = byKey.get(key);
    if (!row) throw new PushFileNotInChangesError();
    picked.set(key, row);
  }
  return [...picked.values()];
}

export async function pushWorkFolder(
  deps: ServiceDeps,
  auth: AuthContext,
  body: PushWorkFolderBody,
): Promise<PushResult> {
  const tenantId = auth.tenant.id;
  await assertTenantWritable(deps, tenantId, 'push');
  const message = commitMessageOf(body);
  const force = body.force === true;
  // the caller's projects first: with none, every name is outside its changes (no lease, fetch or 412)
  const scope = await pushableProjects(deps, auth);
  if (scope !== 'all' && scope.size === 0) throw new PushFileNotInChangesError();
  return withLease(deps, tenantId, async (lease) => {
    const map = await SyncIdMap.load(deps.repos, tenantId);
    const done = await withSession(deps, tenantId, async (session, settings) => {
      const remote = await readBranch(session, settings.branchName, () => lease.extend());
      const rows = await statusRows(deps, tenantId, { remote: remote.parsed, map, scope, direction: 'push' });
      const picked = pickRows(rows, body.fileNames);
      const conflicts = picked.filter((row) => row.conflict);
      if (conflicts.length && !force) {
        throw ApiError.conflict(
          'The remote changed these files since your last pull. Pull first, or push with force.',
          { files: conflicts },
        );
      }
      // the remote's files, with only the picked ones changed; every path is a status row's own path
      const exported = await exportFiles(deps, tenantId, scope, map);
      const files = new Map(remote.raw);
      for (const row of picked) {
        if (row.status === 'deleted') {
          files.delete(row.file);
          continue;
        }
        const bytes = exported.get(row.file);
        if (!bytes) throw new PushFileNotInChangesError();
        files.set(row.file, bytes);
      }
      if (scope !== 'all') {
        await mergeSingleFiles(deps, tenantId, map, picked, remote.parsed, files);
      }
      await lease.extend();
      const commit = await session.writeCommit({
        parent: remote.head,
        files,
        message,
        author: { name: auth.user.name || auth.user.email, email: auth.user.email },
      });
      await lease.extend();
      await session.push(settings.branchName, commit, { force });
      return { commit, picked, files };
    });

    // the versions now on both sides (no Git call from here on)
    const local = await localSnapshot(deps, tenantId, scope);
    for (const row of done.picked) {
      if (!RESOURCE_TYPES.has(row.type)) continue;
      const type = row.type as SyncResourceType;
      if (row.status === 'deleted') {
        map.drop(type, row.id);
        continue;
      }
      const resource = local.resources.find(
        (r) => r.type === row.type && map.gitIdFor(type, r.id) === row.id.toLowerCase(),
      );
      const bytes = done.files.get(row.file);
      if (!resource || !bytes) continue;
      map.record(type, row.id, resource.id, {
        git: fileVersionId(parseFile(row.file, bytes)),
        local: resource.versionId,
      });
    }
    await map.save(deps.repos);
    await deps.repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'source_control.pushed',
      resourceType: 'source_control',
      resourceId: tenantId,
      metadata: { commit: done.commit, files: done.picked.length, force },
    });
    return { files: done.picked.map((row) => ({ ...row, pushed: true })), commit: done.commit };
  });
}

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/**
 * a push limited to some projects: the folders (with their parent chain) and the tag mappings of the picked
 * workflows into the remote's folders.json and tags.json, ids as git ids; every other entry stays as fetched (n8n
 * exports both files with the caller's context filter). A deleted workflow's mappings leave tags.json.
 */
async function mergeSingleFiles(
  deps: ServiceDeps,
  tenantId: string,
  map: SyncIdMap,
  picked: SourceControlledFile[],
  remote: Map<string, ParsedFile>,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const rows = picked.filter((row) => row.type === 'workflow');
  if (!rows.length) return;
  const { repos } = deps;
  const kept: string[] = [];
  const gone = new Set<string>();
  for (const row of rows) {
    const gitId = row.id.toLowerCase();
    if (row.status === 'deleted') {
      gone.add(gitId);
      continue;
    }
    const localId = map.localIdFor('workflow', gitId) ?? gitId;
    if (await repos.workflows.get(tenantId, localId)) kept.push(localId);
  }
  const toGit = <T>(value: T): T => map.rewriteDefinition(value, 'toGit');

  // folders: each picked workflow's folder and its parents, in the workflow's project
  const folderEntries = new Map<string, FoldersFile['folders'][number]>();
  for (const localId of kept) {
    const workflow = await repos.workflows.get(tenantId, localId);
    let folderId = workflow?.folderId ?? null;
    while (folderId && !folderEntries.has(folderId)) {
      const folder = await repos.folders.get(tenantId, folderId);
      if (!folder || folder.projectId !== workflow?.projectId) break;
      folderEntries.set(folder.id, {
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        homeProjectId: folder.projectId,
        createdAt: folder.createdAt.toISOString(),
        updatedAt: folder.updatedAt.toISOString(),
      });
      folderId = folder.parentFolderId;
    }
  }
  if (folderEntries.size) {
    const current = remote.get('folders.json');
    const merged = new Map(
      (current?.type === 'folders' ? current.data.folders : []).map((f) => [f.id.toLowerCase(), f]),
    );
    for (const entry of folderEntries.values()) {
      const git = toGit(entry);
      merged.set(git.id.toLowerCase(), git);
    }
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const data: FoldersFile = { folders: [...merged.values()].sort(byId) };
    const was = current?.type === 'folders' ? [...current.data.folders].sort(byId) : [];
    if (JSON.stringify(was) !== JSON.stringify(data.folders)) files.set('folders.json', encode(data));
  }

  // tags: the picked workflows' mappings replace theirs; their tags are added (or renamed) by id
  const tagsOf = await repos.workflows.tagsFor(tenantId, kept);
  const current = remote.get('tags.json');
  const before: TagsFile = current?.type === 'tags' ? current.data : { tags: [], mappings: [] };
  const pickedGit = new Set([...gone, ...kept.map((id) => map.gitIdFor('workflow', id).toLowerCase())]);
  const tagById = new Map(before.tags.map((t) => [t.id.toLowerCase(), t]));
  const mappings = before.mappings.filter((m) => !pickedGit.has(m.workflowId.toLowerCase()));
  for (const localId of kept) {
    for (const tag of tagsOf.get(localId) ?? []) {
      const git = toGit({ id: tag.id, name: tag.name });
      tagById.set(git.id.toLowerCase(), git);
      mappings.push(toGit({ workflowId: localId, tagId: tag.id }));
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const byPair = (a: TagsFile['mappings'][number], b: TagsFile['mappings'][number]) =>
    `${a.workflowId}:${a.tagId}` < `${b.workflowId}:${b.tagId}` ? -1 : 1;
  const data: TagsFile = { tags: [...tagById.values()].sort(byName), mappings: mappings.sort(byPair) };
  const was = { tags: [...before.tags].sort(byName), mappings: [...before.mappings].sort(byPair) };
  if (JSON.stringify(was) !== JSON.stringify(data)) files.set('tags.json', encode(data));
}
