/**
 * P6-07 (L4): the pull steps (internal to `SourceControlSyncService.pull`), under the lease: the shallow fetch, the
 * parse (one zod schema per kind), the status for the caller's projects; a conflict or a local change without
 * `force` gives 409 with the list. Then, after the Git session is closed, the writes in n8n's order (projects,
 * folders, credentials, workflows, then deletes, tags, variables) through the services inside `withPullWrites`,
 * the `contentImport` policy per workflow, then `autoPublish` once `withPullWrites` has returned (no trigger or
 * timer an activation starts keeps the bypass). The lease is extended before every file's write and every publish.
 *
 * Ids: the services mint every local id, so an incoming resource is created first and its git id recorded against
 * the new local id (`SyncIdMap.record`); a new workflow is made empty first and filled once every id is known, so
 * references between pulled workflows (sub-workflows, the error workflow) and to the pulled credentials, folders and
 * data tables all rewrite in one pass. Data table schemas therefore come before the workflows (n8n writes them last
 * because its ids need no rewrite).
 *
 * Rules (decisions G): existing credentials keep local secrets and take remote expressions, numbers and booleans;
 * new ones arrive as stubs (the service encrypts them fresh under this workspace); an empty variable stub keeps the
 * local value, a new one is created empty; deletes are real and listed; nothing from pin data, static data, rows,
 * secrets or run data; publish only by `autoPublish`, a failed publish lands in `publishingErrors`. A caller without
 * every project pulls only its own projects' files: the files and deletes of other projects are skipped and listed.
 */
import {
  type DataObject,
  type DataTableColumnType,
  type PullResult,
  type PullWorkFolderBody,
  redactSecrets,
  type SourceControlledFile,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SyncResourceType } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { deleteCredential } from '../../routes/credentials';
import { createTag, renameTag } from '../../routes/resources';
import { withPullWrites } from '../protected';
import { evaluateWorkflow } from '../type-policies/enforce';
import { PolicyViolationError, violationMessage } from '../type-policies/errors';
import type { Actor, WorkflowService } from '../workflows';
import { SyncIdMap } from './id-map';
import type {
  CredentialStubFile,
  DataTableFile,
  FileOwner,
  FoldersFile,
  ParsedFile,
  ProjectFile,
  TagsFile,
  VariableStub,
  WorkflowFile,
} from './import-schemas';
import type { SourceControlLease } from './lock';
import { findOwner, resolveOwner } from './owners';
import { fileVersionId, localSnapshot } from './status';
import { readBranch, rowKey, statusRows, withLease, withSession } from './sync';

type Scope = 'all' | Set<string>;
type Imported = { type: SyncResourceType; gitId: string; localId: string; file: ParsedFile };
type Skipped = PullResult['contentImportPolicy'][number];

const OUTSIDE_PROJECTS = 'Skipped: the file belongs to a project outside the projects you may pull.';
const CONFLICT_TEXT =
  'The workspace has changes a pull would overwrite. Push them first, or pull with force to take the remote version.';

/**
 * The projects a caller may pull (n8n's source control context): every project with the global `project:update`
 * (owners and admins), else the team projects whose relation role holds `sourceControl:push` (project admins).
 */
export async function pullableProjects(deps: ServiceDeps, auth: AuthContext): Promise<Scope> {
  const access = deps.context().access;
  const global = await access.scopesForAuth(auth);
  if (global.has('project:update')) return 'all';
  const ids = new Set(await access.accessibleProjectIds(auth, 'sourceControl:push'));
  const out = new Set<string>();
  for (const project of await deps.repos.projects.listAll(auth.tenant.id)) {
    if (project.type === 'team' && ids.has(project.id)) out.add(project.id);
  }
  return out;
}

/** a remote credential stub merged into the local data: secrets stay, expressions, numbers and booleans come in */
function mergeStub(stored: DataObject, remote: DataObject): DataObject {
  const merged: DataObject = { ...stored };
  for (const [key, value] of Object.entries(remote)) {
    // the stub went through `sanitizeCredentialData`: a string left in it is an expression
    if (typeof value === 'string') {
      if (value !== '') merged[key] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

/** the lease codes: a lost or busy lease stops the whole pull, never one file */
const LEASE_CODES: ReadonlySet<string> = new Set(['source_control_busy', 'source_control_lease_lost']);

/**
 * the text of a refused file, as the pull result shows it (no secret, no stack): a policy violation, a save rule
 * (400), a name clash (409) or the team project limit (403 `plan_limit`); a lease error is never a file's refusal
 */
function refusalOf(error: unknown): string[] | undefined {
  if (error instanceof PolicyViolationError) {
    return error.violations.map((v) => violationMessage([v]));
  }
  if (!(error instanceof ApiError) || LEASE_CODES.has(error.code)) return undefined;
  const refused =
    error.statusCode === 400 ||
    error.statusCode === 409 ||
    (error.statusCode === 403 && error.code === 'plan_limit');
  return refused ? [redactSecrets(error.message)] : undefined;
}

class PullRun {
  readonly tenantId: string;
  readonly actor: Actor;
  readonly files: SourceControlledFile[] = [];
  readonly skipped: Skipped[] = [];
  readonly publishingErrors: PullResult['publishingErrors'] = [];
  readonly imported: Imported[] = [];
  /** the workflows this pull wrote: local id, name and whether they were published before */
  readonly pulledWorkflows: Array<{ id: string; name: string; wasPublished: boolean; archived: boolean }> =
    [];

  constructor(
    readonly deps: ServiceDeps,
    readonly auth: AuthContext,
    readonly map: SyncIdMap,
    readonly remote: Map<string, ParsedFile>,
    readonly scope: Scope,
    readonly rows: SourceControlledFile[],
    /** extended before every file's write and every publish: a lost lease stops the pull with 409 */
    readonly lease: SourceControlLease,
  ) {
    this.tenantId = auth.tenant.id;
    this.actor = { userId: auth.user.id };
  }

  private get ctx() {
    return this.deps.context();
  }

  private inScope(projectId: string | null | undefined): boolean {
    return this.scope === 'all' || (!!projectId && this.scope.has(projectId));
  }

  private rowsOf(type: SourceControlledFile['type'], deleted = false) {
    return this.rows.filter((row) => row.type === type && (row.status === 'deleted') === deleted);
  }

  private fileOf<T extends ParsedFile['type']>(row: SourceControlledFile, type: T) {
    const file = this.remote.get(row.file);
    return file && file.type === type ? (file as Extract<ParsedFile, { type: T }>) : undefined;
  }

  /** runs one file's writes; a refusal by a policy or a save rule skips that file and lists it */
  private async perFile(row: { id: string; name: string }, fn: () => Promise<void>): Promise<boolean> {
    // the lease first, outside the refusal handling: a lost lease (409) stops the run before the next write
    await this.lease.extend();
    try {
      await fn();
      return true;
    } catch (error) {
      const violations = refusalOf(error);
      if (!violations) throw error;
      this.skipped.push({ id: row.id, name: row.name, violations });
      return false;
    }
  }

  /**
   * the local project a file's owner names (personal by email, team through the map); none: the puller's own. A
   * missing team project is made (through the project service) only for a caller with every project; a caller
   * limited to some projects only looks up, so a file of an unknown team is outside its projects.
   */
  private async ownerProject(owner: FileOwner | null): Promise<string | undefined> {
    if (!owner) return this.ctx.access.targetProject(this.auth, null);
    const puller = { userId: this.auth.user.id, auth: this.auth };
    if (this.scope !== 'all') return findOwner(this.deps, this.tenantId, owner, puller, this.map);
    return resolveOwner(this.deps, this.tenantId, owner, puller, this.map);
  }

  /** every write, inside `withPullWrites`; the publish runs after it (`publish`) */
  async run(): Promise<void> {
    await this.projects();
    await this.folders();
    await this.credentials();
    await this.dataTables();
    await this.workflows();
    await this.deletes();
    await this.tags();
    if (this.scope === 'all') {
      const file = this.remote.get('variable_stubs.json');
      if (file?.type === 'variables') await this.syncVariables(file.data, null);
    }
    this.listSingleFiles();
  }

  // ---- projects (team projects, with their variable stubs) ----
  private async projects(): Promise<void> {
    for (const row of this.rowsOf('project')) {
      const file = this.fileOf(row, 'project');
      if (!file) continue;
      const data: ProjectFile = file.data;
      const mapped = this.map.localIdFor('project', file.id);
      const existing = mapped ? await this.deps.repos.projects.get(this.tenantId, mapped) : undefined;
      if (existing ? !this.inScope(existing.id) : this.scope !== 'all') continue;
      let localId = existing?.id ?? '';
      const ok = await this.perFile(row, async () => {
        if (existing) {
          if (
            existing.name !== data.name ||
            (existing.description ?? null) !== data.description ||
            JSON.stringify(existing.icon ?? null) !== JSON.stringify(data.icon)
          ) {
            await this.ctx.projects.update(this.auth, localId, {
              name: data.name,
              icon: data.icon,
              description: data.description,
            });
          }
        } else {
          const created = await this.ctx.projects.create(this.auth, {
            name: data.name,
            icon: data.icon,
            description: data.description,
          });
          localId = created.id;
          this.map.record('project', file.id, localId, {});
        }
        await this.syncVariables(data.variableStubs ?? [], localId);
      });
      if (!ok) continue;
      this.imported.push({ type: 'project', gitId: file.id, localId, file });
      this.files.push(row);
    }
  }

  // ---- folders (folders.json: the folders of the projects in scope; deletes only for every project) ----
  private async folderProject(folder: FoldersFile['folders'][number]): Promise<string | undefined> {
    const team = this.map.localIdFor('project', folder.homeProjectId);
    if (team && (await this.deps.repos.projects.get(this.tenantId, team))) return team;
    // a personal project's folder: the owner of a workflow file inside it, else the puller (for a caller limited to
    // some projects `ownerProject` only looks the owner up and makes no project)
    for (const file of this.remote.values()) {
      if (file.type === 'workflow' && file.data.parentFolderId === folder.id) {
        return this.ownerProject(file.data.owner);
      }
    }
    return this.scope === 'all' ? this.ctx.access.targetProject(this.auth, null) : undefined;
  }

  private async folders(): Promise<void> {
    const file = this.remote.get('folders.json');
    if (file?.type !== 'folders') return;
    const pending = [...file.data.folders];
    const remoteIds = new Set(pending.map((f) => f.id));
    // parents first; a folder whose parent never comes goes to the root
    while (pending.length) {
      let index = pending.findIndex(
        (f) =>
          !f.parentFolderId ||
          !remoteIds.has(f.parentFolderId) ||
          !pending.some((p) => p.id === f.parentFolderId),
      );
      if (index === -1) index = 0;
      const [folder] = pending.splice(index, 1);
      await this.perFile(folder, () => this.writeFolder(folder));
    }
    if (this.scope !== 'all') return;
    for (const entry of this.map.entries('folder')) {
      if (remoteIds.has(entry.gitId)) continue;
      if (await this.deps.repos.folders.get(this.tenantId, entry.localId)) {
        await this.ctx.folders.delete(
          this.tenantId,
          entry.localId,
          { transferToFolderId: 'root' },
          this.actor,
        );
      }
      this.map.drop('folder', entry.gitId);
    }
  }

  /**
   * one folder of folders.json: created or changed in its project when that project is the caller's; a mapped
   * folder of another project (or one the file would move to another project) is left as it is
   */
  private async writeFolder(folder: FoldersFile['folders'][number]): Promise<void> {
    const projectId = await this.folderProject(folder);
    if (!projectId || !this.inScope(projectId)) return;
    // the mapped folder, else a folder of this workspace with the git id itself (the first pusher's own)
    const mapped = this.map.localIdFor('folder', folder.id);
    const existing = await this.deps.repos.folders.get(this.tenantId, mapped ?? folder.id);
    if (existing && (existing.projectId !== projectId || !this.inScope(existing.projectId))) return;
    if (existing && !mapped) this.map.record('folder', folder.id, existing.id, {});
    const parentLocal = folder.parentFolderId
      ? (this.map.localIdFor('folder', folder.parentFolderId) ?? folder.parentFolderId)
      : undefined;
    const parent = parentLocal ? await this.deps.repos.folders.get(this.tenantId, parentLocal) : undefined;
    const parentFolderId = parent && parent.projectId === projectId ? parent.id : null;
    if (existing) {
      if (existing.name !== folder.name || existing.parentFolderId !== parentFolderId) {
        await this.ctx.folders.update(
          this.tenantId,
          existing.id,
          {
            ...(existing.name !== folder.name ? { name: folder.name } : {}),
            ...(existing.parentFolderId !== parentFolderId ? { parentFolderId } : {}),
          },
          this.actor,
        );
      }
      return;
    }
    const created = await this.ctx.folders.create(
      this.tenantId,
      { name: folder.name, parentFolderId, projectId },
      this.actor,
    );
    this.map.record('folder', folder.id, created.id, {});
  }

  // ---- credentials (stubs) ----
  private async credentials(): Promise<void> {
    const shareGlobally = (await this.ctx.access.scopesForAuth(this.auth)).has('credential:shareGlobally');
    for (const row of this.rowsOf('credential')) {
      const file = this.fileOf(row, 'credential');
      if (!file) continue;
      const data: CredentialStubFile = file.data;
      const mapped = this.map.localIdFor('credential', file.id);
      const existing = mapped ? await this.deps.repos.credentials.get(this.tenantId, mapped) : undefined;
      let localId = existing?.id ?? '';
      const ok = await this.perFile(row, async () => {
        if (existing) {
          // the mapped row's project decides, never the owner the file names (decisions G)
          if (!this.inScope(existing.projectId)) {
            throw new ApiError(400, 'source_control_scope', OUTSIDE_PROJECTS);
          }
          const merged = mergeStub(this.ctx.credentials.decrypt(existing), data.data);
          await this.ctx.credentials.update(this.tenantId, existing.id, {
            name: data.name,
            data: merged,
            isResolvable: data.isResolvable,
            ...(shareGlobally ? { isGlobal: data.isGlobal } : {}),
          });
          return;
        }
        const projectId = await this.ownerProject(data.owner);
        if (!projectId || !this.inScope(projectId)) {
          throw new ApiError(400, 'source_control_scope', OUTSIDE_PROJECTS);
        }
        // a stub: secrets empty; the service encrypts it fresh under this workspace's binding
        const created = await this.ctx.credentials.create(
          this.tenantId,
          { name: data.name, type: data.type, data: data.data, projectId, isResolvable: data.isResolvable },
          this.auth.user.id,
        );
        localId = created.id;
        if (shareGlobally && data.isGlobal) {
          await this.ctx.credentials.update(this.tenantId, localId, { isGlobal: true });
        }
        this.map.record('credential', file.id, localId, {});
      });
      if (!ok) continue;
      this.imported.push({ type: 'credential', gitId: file.id, localId, file });
      this.files.push(row);
    }
  }

  // ---- data table schemas (no rows), before the workflows that name them ----
  private async dataTables(): Promise<void> {
    for (const row of this.rowsOf('datatable')) {
      const file = this.fileOf(row, 'datatable');
      if (!file) continue;
      const data: DataTableFile = file.data;
      const columns = [...data.columns]
        .sort((a, b) => a.index - b.index)
        .map((c) => ({ name: c.name, type: c.type as DataTableColumnType }));
      const mapped = this.map.localIdFor('datatable', file.id);
      const existing = mapped ? await this.deps.repos.dataTables.get(this.tenantId, mapped) : undefined;
      let localId = existing?.id ?? '';
      const ok = await this.perFile(row, async () => {
        if (existing) {
          if (!this.inScope(existing.projectId)) {
            throw new ApiError(400, 'source_control_scope', OUTSIDE_PROJECTS);
          }
          if (existing.name !== data.name) {
            await this.ctx.dataTables.patch(this.tenantId, existing.id, { name: data.name }, this.actor);
          }
          await this.syncColumns(existing.id, columns);
          return;
        }
        const projectId = await this.ownerProject({ type: 'team', teamId: data.projectId, teamName: '' });
        if (!projectId || !this.inScope(projectId)) {
          throw new ApiError(400, 'source_control_scope', OUTSIDE_PROJECTS);
        }
        const made = await this.ctx.dataTables.create(
          this.tenantId,
          { name: data.name, columns, projectId },
          this.actor,
        );
        localId = made.id;
        this.map.record('datatable', file.id, localId, {});
      });
      if (!ok) continue;
      this.imported.push({ type: 'datatable', gitId: file.id, localId, file });
      this.files.push(row);
    }
  }

  /** the table's columns become the remote's, in its order (a column of another type is dropped and added again) */
  private async syncColumns(tableId: string, wanted: Array<{ name: string; type: DataTableColumnType }>) {
    const methods = this.ctx.dataTables.columns;
    let current = await this.deps.repos.dataTables.listColumns(this.tenantId, tableId);
    for (const column of current) {
      if (!wanted.some((w) => w.name === column.name && w.type === column.type)) {
        await methods.delete(this.tenantId, tableId, column.id, this.actor);
      }
    }
    for (const [index, want] of wanted.entries()) {
      current = await this.deps.repos.dataTables.listColumns(this.tenantId, tableId);
      const found = current.find((c) => c.name === want.name);
      if (!found) {
        await methods.add(this.tenantId, tableId, { name: want.name, type: want.type, index }, this.actor);
      } else if (current.indexOf(found) !== index) {
        await methods.move(this.tenantId, tableId, found.id, { targetIndex: index }, this.actor);
      }
    }
  }

  // ---- workflows ----
  private unknownTypes(nodes: WorkflowNode[]): string[] {
    const types = this.ctx.registries.nodeTypes;
    return [...new Set(nodes.map((n) => n.type).filter((type) => !types.get(type)))];
  }

  private async workflows(): Promise<void> {
    const service: WorkflowService = this.ctx.workflows;
    const work: Array<{ row: SourceControlledFile; file: WorkflowFile; gitId: string; made: boolean }> = [];
    // the policy first, then an empty workflow for each new one, so every local id is known before the rewrite
    for (const row of this.rowsOf('workflow')) {
      const parsed = this.fileOf(row, 'workflow');
      if (!parsed) continue;
      const file = parsed.data;
      const unknown = this.unknownTypes(file.nodes);
      if (unknown.length) {
        this.skipped.push({
          id: row.id,
          name: row.name,
          violations: unknown.map((type) => `Node type "${type}" is not installed in this workspace`),
        });
        continue;
      }
      const mapped = this.map.localIdFor('workflow', parsed.id);
      const existing = mapped ? await this.deps.repos.workflows.get(this.tenantId, mapped) : undefined;
      let made = false;
      const ok = await this.perFile(row, async () => {
        const projectId = existing?.projectId ?? (await this.ownerProject(file.owner));
        if (!projectId || !this.inScope(projectId)) {
          throw new ApiError(400, 'source_control_scope', OUTSIDE_PROJECTS);
        }
        await evaluateWorkflow(this.deps, 'contentImport', {
          tenantId: this.tenantId,
          projectId,
          workflow: { nodes: file.nodes },
        });
        if (existing) return;
        const created = await service.create(
          this.tenantId,
          { name: file.name, nodes: [], connections: {}, folderId: null, projectId },
          this.actor,
        );
        this.map.record('workflow', parsed.id, created.id, {});
        made = true;
      });
      if (ok) work.push({ row, file, gitId: parsed.id, made });
    }
    for (const item of work) await this.writeWorkflow(service, item);
  }

  private async writeWorkflow(
    service: WorkflowService,
    item: { row: SourceControlledFile; file: WorkflowFile; gitId: string; made: boolean },
  ): Promise<void> {
    const { row, gitId, made } = item;
    const localId = this.map.localIdFor('workflow', gitId);
    if (!localId) return;
    const def = this.map.rewriteDefinition(item.file, 'toLocal');
    const before = await service.get(this.tenantId, localId);
    const ok = await this.perFile(row, async () => {
      if (!before.isArchived) return this.saveWorkflow(service, localId, before, def);
      // an archived workflow takes no save: unarchived for it, archived again when the file says so or the save
      // is refused
      await this.ctx.workflowArchive.unarchive(this.tenantId, localId, this.actor);
      try {
        await this.saveWorkflow(service, localId, before, def);
      } catch (error) {
        await this.ctx.workflowArchive.archive(this.tenantId, localId, this.actor, { publicApi: true });
        throw error;
      }
    });
    if (!ok) {
      if (made) {
        await service.delete(this.tenantId, localId, this.actor, { force: true });
        this.map.drop('workflow', gitId);
      }
      return;
    }
    this.pulledWorkflows.push({
      id: localId,
      name: def.name,
      wasPublished: before.active,
      archived: def.isArchived,
    });
    const parsed = this.remote.get(row.file) as ParsedFile;
    this.imported.push({ type: 'workflow', gitId, localId, file: parsed });
    this.files.push(row);
  }

  /** the file's definition saved on an unarchived workflow, its folder set, then archived when the file says so */
  private async saveWorkflow(
    service: WorkflowService,
    localId: string,
    before: Awaited<ReturnType<WorkflowService['get']>>,
    def: WorkflowFile,
  ): Promise<void> {
    const update = {
      versionId: before.versionId,
      name: def.name,
      nodes: def.nodes,
      connections: def.connections,
      settings: def.settings ?? {},
      stickyNotes: def.stickyNotes ?? [],
      nodeGroups: def.nodeGroups ?? [],
    } as Parameters<WorkflowService['update']>[2];
    const saved = await service.update(this.tenantId, localId, update, this.actor, 'Pulled from Git');
    if (def.description) {
      await service.updateVersion(
        this.tenantId,
        localId,
        saved.versionId,
        { description: def.description.slice(0, 2000) },
        this.actor,
      );
    }
    const folder = def.parentFolderId
      ? await this.deps.repos.folders.get(this.tenantId, def.parentFolderId)
      : undefined;
    const folderId = folder && folder.projectId === before.projectId ? folder.id : null;
    if (before.folderId !== folderId) {
      await this.ctx.workflowArchive.move(this.tenantId, [localId], folderId, this.actor);
    }
    if (def.isArchived) {
      await this.ctx.workflowArchive.archive(this.tenantId, localId, this.actor, { publicApi: true });
    }
  }

  // ---- deletes (real, as n8n; listed) ----
  private async deletes(): Promise<void> {
    const order: Array<'workflow' | 'credential' | 'datatable' | 'project'> = [
      'workflow',
      'credential',
      'datatable',
      'project',
    ];
    for (const type of order) {
      for (const row of this.rowsOf(type, true)) {
        if (row.location !== 'remote') continue;
        const localId = this.map.localIdFor(type, row.id);
        if (!localId) continue;
        const ok = await this.perFile(row, () => this.deleteOne(type, localId));
        if (!ok) continue;
        this.map.drop(type, row.id);
        this.files.push(row);
      }
    }
  }

  private async deleteOne(
    type: 'workflow' | 'credential' | 'datatable' | 'project',
    id: string,
  ): Promise<void> {
    const { repos } = this.deps;
    switch (type) {
      case 'workflow':
        if (await repos.workflows.get(this.tenantId, id)) {
          await this.ctx.workflows.delete(this.tenantId, id, this.actor, { force: true });
        }
        return;
      case 'credential':
        if (await repos.credentials.get(this.tenantId, id)) {
          await deleteCredential(this.ctx, this.tenantId, id, this.auth.user.id, '');
        }
        return;
      case 'datatable':
        if (await repos.dataTables.get(this.tenantId, id)) {
          await this.ctx.dataTables.delete(this.tenantId, id, this.actor);
        }
        return;
      case 'project':
        if (await repos.projects.get(this.tenantId, id)) await this.ctx.projects.delete(this.auth, id);
        return;
    }
  }

  // ---- tags (tags.json; every project only) ----
  private async tags(): Promise<void> {
    if (this.scope !== 'all') return;
    const file = this.remote.get('tags.json');
    if (file?.type !== 'tags') return;
    const data: TagsFile = file.data;
    const { repos } = this.deps;
    for (const tag of data.tags) {
      const mapped = this.map.localIdFor('tag', tag.id);
      const existing = mapped ? await repos.tags.get(this.tenantId, mapped) : undefined;
      if (existing) {
        if (existing.name !== tag.name) await renameTag(this.ctx, this.tenantId, existing.id, tag.name);
        continue;
      }
      const byName = await repos.tags.getByName(this.tenantId, tag.name);
      const localId = byName ? byName.id : (await createTag(this.ctx, this.tenantId, tag.name)).id;
      this.map.record('tag', tag.id, localId, {});
    }
    const remoteIds = new Set(data.tags.map((t) => t.id));
    for (const entry of this.map.entries('tag')) {
      if (remoteIds.has(entry.gitId)) continue;
      await repos.tags.delete(this.tenantId, entry.localId);
      this.map.drop('tag', entry.gitId);
    }
    // the tags of every pulled or synced workflow become the remote's
    const wanted = new Map<string, Set<string>>();
    for (const mapping of data.mappings) {
      const workflowId = this.map.localIdFor('workflow', mapping.workflowId);
      const tagId = this.map.localIdFor('tag', mapping.tagId);
      if (!workflowId || !tagId) continue;
      const set = wanted.get(workflowId) ?? new Set<string>();
      set.add(tagId);
      wanted.set(workflowId, set);
    }
    const workflowIds: string[] = [];
    for (const file of this.remote.values()) {
      if (file.type !== 'workflow') continue;
      const localId = this.map.localIdFor('workflow', file.id);
      if (localId && (await repos.workflows.get(this.tenantId, localId))) workflowIds.push(localId);
    }
    const current = await repos.workflows.tagsFor(this.tenantId, workflowIds);
    for (const id of workflowIds) {
      const want = [...(wanted.get(id) ?? [])].sort();
      const have = (current.get(id) ?? []).map((t) => t.id).sort();
      if (want.join(',') !== have.join(',')) await repos.workflows.setTags(this.tenantId, id, want);
    }
  }

  // ---- variables: global (variable_stubs.json) and per project (a project file's stubs) ----
  private async syncVariables(stubs: VariableStub[], projectId: string | null): Promise<void> {
    const service = this.ctx.variables;
    const locals = await this.deps.repos.variables.list(this.tenantId, { projectId });
    for (const stub of stubs) {
      const mapped = this.map.localIdFor('variable', stub.id);
      const existing = locals.find((v) => v.id === mapped) ?? locals.find((v) => v.key === stub.key);
      if (existing) {
        // an empty stub keeps the local value
        if (existing.key !== stub.key) await service.update(this.auth, existing.id, { key: stub.key });
        this.map.record('variable', stub.id, existing.id, {});
        continue;
      }
      const created = await service.create(this.auth, { key: stub.key, value: '', projectId });
      this.map.record('variable', stub.id, created.id, {});
    }
    const remoteIds = new Set(stubs.map((s) => s.id));
    for (const variable of locals) {
      const entry = this.map.entryForLocal('variable', variable.id);
      if (!entry || remoteIds.has(entry.gitId)) continue;
      await service.delete(this.auth, variable.id);
      this.map.drop('variable', entry.gitId);
    }
  }

  /** the single files the pull applied (every project only) */
  private listSingleFiles(): void {
    if (this.scope !== 'all') return;
    for (const type of ['folders', 'tags', 'variables'] as const) {
      for (const row of this.rowsOf(type)) this.files.push(row);
    }
  }

  // ---- publish (autoPublish only), after the writes and outside `withPullWrites`: no trigger or timer it starts
  // keeps the bypass (publish is allowed on a protected workspace and needs none) ----
  async publish(mode: NonNullable<PullWorkFolderBody['autoPublish']>): Promise<void> {
    if (mode === 'none') return;
    for (const workflow of this.pulledWorkflows) {
      if (workflow.archived) continue;
      if (mode === 'published' && !workflow.wasPublished) continue;
      await this.lease.extend();
      try {
        await this.ctx.workflows.setActive(this.tenantId, workflow.id, true, this.actor);
      } catch (error) {
        this.publishingErrors.push({
          id: workflow.id,
          name: workflow.name,
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      }
    }
  }

  /** the versions now on both sides, for the next status */
  async recordVersions(): Promise<void> {
    const local = await localSnapshot(this.deps, this.tenantId, this.scope);
    for (const item of this.imported) {
      const resource = local.resources.find((r) => r.type === item.file.type && r.id === item.localId);
      if (!resource) continue;
      this.map.record(item.type, item.gitId, item.localId, {
        git: fileVersionId(item.file),
        local: resource.versionId,
      });
    }
  }
}

export async function pullWorkFolder(
  deps: ServiceDeps,
  auth: AuthContext,
  body: PullWorkFolderBody,
): Promise<PullResult> {
  const tenantId = auth.tenant.id;
  return withLease(deps, tenantId, async (lease) => {
    const scope = await pullableProjects(deps, auth);
    const remote = await withSession(deps, tenantId, (session, settings) =>
      readBranch(session, settings.branchName, () => lease.extend()),
    );
    const map = await SyncIdMap.load(deps.repos, tenantId);
    const rows = await statusRows(deps, tenantId, { remote: remote.parsed, map, scope, direction: 'pull' });
    if (body.force !== true && rows.some((row) => row.conflict)) {
      throw ApiError.conflict(CONFLICT_TEXT, { files: rows });
    }
    // what the caller's projects leave out: listed, never applied
    const outside: Skipped[] = [];
    if (scope !== 'all') {
      const mine = new Set(rows.map(rowKey));
      const every = await statusRows(deps, tenantId, {
        remote: remote.parsed,
        map,
        scope: 'all',
        direction: 'pull',
      });
      for (const row of every) {
        if (row.type === 'folders' || mine.has(rowKey(row))) continue;
        outside.push({ id: row.id, name: row.name, violations: [OUTSIDE_PROJECTS] });
      }
    }
    await lease.extend();
    const run = new PullRun(deps, auth, map, remote.parsed, scope, rows, lease);
    try {
      await withPullWrites(() => run.run());
      // the activations start triggers and timers: never inside the bypass, so none of them inherits it
      await run.publish(body.autoPublish ?? 'none');
    } finally {
      // what was written stays mapped, even when a later step failed
      await run.recordVersions();
      await map.save(deps.repos);
    }
    await deps.repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'source_control.pulled',
      resourceType: 'source_control',
      resourceId: tenantId,
      metadata: { commit: remote.head, files: run.files.length, force: body.force === true },
    });
    return {
      files: run.files,
      publishingErrors: run.publishingErrors,
      contentImportPolicy: [...run.skipped, ...outside],
    };
  });
}
