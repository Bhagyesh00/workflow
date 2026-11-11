/**
 * P6-07 (L4): the push steps (internal to `SourceControlSyncService.push`): `assertTenantWritable(..., 'push')`
 * first, then under the lease: the shallow fetch, the caller's own status within `pushableProjects`, the picked files
 * only (GHSA-hvrx-jc5j-pg3w: the client names id and type, every path comes from that status; a name outside it is
 * refused), conflicts without `force` give 409 with the list, one commit on the fetched head holding the remote's
 * files with only the picked ones changed (message trimmed, 1 to 1000, default "Updated Workfolder"), then the push
 * (`force` as given, as n8n). The lease is extended after the fetch, before the commit and before the push. The id
 * map is written after the push, outside any Git call.
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
import { parseFile } from './import-schemas';
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
    if (!row) throw ApiError.badRequest('A picked file is not part of the changes.');
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
  return withLease(deps, tenantId, async (lease) => {
    const scope = await pushableProjects(deps, auth);
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
        if (!bytes) throw ApiError.badRequest('A picked file is not part of the changes.');
        files.set(row.file, bytes);
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
