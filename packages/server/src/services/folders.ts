/**
 * Folders (P3-07): create, rename, tags, move (no cycles), delete with transfer, counts.
 *
 * The editor routes (routes/folders.ts) and the public API (routes/public-folders.ts) both call
 * this service, so the rules and the tenant checks are the same for both.
 */
import type { Scope } from '@workflow/workflow';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceDeps } from '../context';
import type { FolderRow, ProjectRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { decodeCursor, encodeCursor, page } from '../http/pagination';
import type { TagRef } from '../repositories';
import { createRepositories, isUuid } from '../repositories';
import type { AccessListOptions } from '../repositories/shares';
import { MISSING_SCOPE_MESSAGE } from './access';
import { assertFolderInTenant } from './workflow-rules';
import type { Actor } from './workflows';

/** characters n8n refuses in a folder name */
const FORBIDDEN_NAME_CHARS = /[[\]^\\/:*?"<>|]/;

/** The folder name rule (as n8n's folder schema): trimmed, 1..128 characters, no special characters, not only dots, no leading dot. */
export const folderNameSchema = z
  .string()
  .trim()
  .min(1, 'The folder name cannot be empty')
  .max(128, 'The folder name can be at most 128 characters')
  .refine((v) => !FORBIDDEN_NAME_CHARS.test(v), 'The folder name cannot contain [ ] ^ \\ / : * ? " < > |')
  .refine((v) => !/^\.+$/.test(v), 'The folder name cannot be only dots')
  .refine((v) => !v.startsWith('.'), 'The folder name cannot start with a dot');

const folderRef = z.union([z.uuid(), z.literal('root')]);

export const folderCreateSchema = z.object({
  name: folderNameSchema,
  parentFolderId: z.uuid().nullable().optional(),
});

export const folderUpdateSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentFolderId: z.uuid().nullable().optional(),
    /** replaces the folder's tags; workspace tags only */
    tagIds: z.array(z.uuid()).max(50).optional(),
  })
  .refine((v) => v.name !== undefined || v.parentFolderId !== undefined || v.tagIds !== undefined, {
    message: 'Nothing to update',
  });

export const folderDeleteSchema = z.object({
  /** a folder id or 'root'; omitted = the workflows go to the root and are archived */
  transferToFolderId: folderRef.optional(),
});

/** "a,b" -> ['a', 'b'] */
const nameList = z
  .string()
  .max(2000)
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  )
  .pipe(z.array(z.string().max(24)).max(20).optional());

export const folderListQuerySchema = z.object({
  parentFolderId: folderRef.optional(),
  search: z.string().max(128).optional(),
  tags: nameList,
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});

export type FolderCreateInput = z.output<typeof folderCreateSchema>;
export type FolderUpdateInput = z.output<typeof folderUpdateSchema>;
export type FolderDeleteInput = z.output<typeof folderDeleteSchema>;
export type FolderListQuery = z.output<typeof folderListQuerySchema>;

export interface FolderDTO {
  id: string;
  name: string;
  parentFolderId: string | null;
  tags: TagRef[];
  createdAt: string;
  updatedAt: string;
}

export interface FolderDetailDTO extends FolderDTO {
  path: Array<{ id: string; name: string }>;
  workflowCount: number;
  subFolderCount: number;
}

/** a project as a folder row names its home (the shape of the other project-owned rows) */
export interface FolderProjectRef {
  id: string;
  name: string;
  type: ProjectRow['type'];
  icon: ProjectRow['icon'];
}

/** the access fields of a folder row (P6-26): the owner project and the caller's scopes there; a folder is never shared */
export interface FolderAccessFields {
  projectId: string;
  homeProject: FolderProjectRef | null;
  sharedWithProjects: FolderProjectRef[];
  scopes?: Scope[];
}

const toDTO = (row: FolderRow, tags: TagRef[]): FolderDTO => ({
  id: row.id,
  name: row.name,
  parentFolderId: row.parentFolderId,
  tags,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class FolderService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private async require(tenantId: string, id: string): Promise<FolderRow> {
    const row = await this.repos.folders.get(tenantId, id);
    if (!row) throw ApiError.notFound('Folder');
    return row;
  }

  private async dto(tenantId: string, row: FolderRow): Promise<FolderDTO> {
    const tags = await this.repos.folders.tagsFor(tenantId, [row.id]);
    return toDTO(row, tags.get(row.id) ?? []);
  }

  private async pageRows(tenantId: string, query: FolderListQuery, access: AccessListOptions = {}) {
    const cursor = decodeCursor(query.cursor);
    if (cursor && !isUuid(cursor.id)) throw ApiError.badRequest('Invalid cursor');
    const rows = await this.repos.folders.list(tenantId, { ...query, ...access, cursor });
    const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.name, r.id));
    const tags = await this.repos.folders.tagsFor(
      tenantId,
      data.map((r) => r.id),
    );
    return { rows: data, tags, nextCursor };
  }

  async list(
    tenantId: string,
    query: FolderListQuery,
  ): Promise<{ data: FolderDTO[]; nextCursor: string | null }> {
    const { rows, tags, nextCursor } = await this.pageRows(tenantId, query);
    return { data: rows.map((r) => toDTO(r, tags.get(r.id) ?? [])), nextCursor };
  }

  /**
   * The list of GET /folders for a caller (P6-26): the access filter of `folder:list`, the project filter
   * (`projectId` needs `folder:list` in that project; `onlySharedWithMe` matches nothing, a folder is never
   * shared) and every row with its project and, with `includeScopes`, `scopes`.
   */
  async listFor(
    auth: AuthContext,
    query: FolderListQuery & { projectId?: string; onlySharedWithMe?: boolean; includeScopes?: boolean },
  ) {
    const { access } = this.deps.context();
    const { includeScopes, projectId, onlySharedWithMe, ...rest } = query;
    if (projectId) {
      const held = await access.scopesForAuth(auth, { projectId });
      if (!held.has('folder:list')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    }
    const filter = await access.listFilter(auth, 'folder:list');
    const { rows, tags, nextCursor } = await this.pageRows(auth.tenant.id, rest, {
      filter,
      projectId,
      onlySharedWithMe,
    });
    const fields = await this.accessFields(auth, rows, includeScopes === true);
    return {
      data: rows.map((r) => ({ ...toDTO(r, tags.get(r.id) ?? []), ...fields.get(r.id) })),
      nextCursor,
    };
  }

  /** `projectId`, `homeProject` and (with `includeScopes`) the caller's `scopes` of each row; a folder's scopes are its project's */
  async accessFields(
    auth: AuthContext,
    rows: Array<{ id: string; projectId: string }>,
    includeScopes: boolean,
  ): Promise<Map<string, FolderAccessFields>> {
    const { access } = this.deps.context();
    const result = new Map<string, FolderAccessFields>();
    if (!rows.length) return result;
    const refs = new Map<string, FolderProjectRef>();
    for (const p of await this.repos.projects.listAll(auth.tenant.id)) {
      refs.set(p.id, { id: p.id, name: p.name, type: p.type, icon: p.icon ?? null });
    }
    const scopes = new Map<string, Scope[]>();
    if (includeScopes) {
      for (const projectId of new Set(rows.map((r) => r.projectId))) {
        scopes.set(projectId, [...(await access.scopesForAuth(auth, { projectId }))].sort());
      }
    }
    for (const row of rows) {
      result.set(row.id, {
        projectId: row.projectId,
        homeProject: refs.get(row.projectId) ?? null,
        sharedWithProjects: [],
        ...(includeScopes ? { scopes: scopes.get(row.projectId) } : {}),
      });
    }
    return result;
  }

  /** a folder as GET one, POST and PATCH answer it: the DTO plus its project and the caller's scopes */
  async dtoFor<T extends FolderDTO>(auth: AuthContext, dto: T) {
    const row = await this.require(auth.tenant.id, dto.id);
    const fields = await this.accessFields(auth, [row], true);
    return { ...dto, ...fields.get(dto.id)! };
  }

  async get(tenantId: string, id: string): Promise<FolderDetailDTO> {
    const row = await this.require(tenantId, id);
    const [base, path, counts] = await Promise.all([
      this.dto(tenantId, row),
      this.repos.folders.ancestors(tenantId, id),
      this.repos.folders.counts(tenantId, id),
    ]);
    return { ...base, path, ...counts };
  }

  async create(
    tenantId: string,
    input: FolderCreateInput & { projectId?: string },
    actor: Actor,
  ): Promise<FolderDTO> {
    const parentFolderId = input.parentFolderId ?? null;
    await assertFolderInTenant(this.repos, tenantId, parentFolderId);
    // P6 S1: the project the route resolved, else the parent's, else the workspace's default (L24 makes it required)
    const parent = parentFolderId ? await this.repos.folders.get(tenantId, parentFolderId) : undefined;
    if (parent && input.projectId && parent.projectId !== input.projectId) {
      throw ApiError.badRequest('The parent folder belongs to another project.');
    }
    const projectId =
      input.projectId ?? parent?.projectId ?? (await this.repos.projects.defaultProjectFor(tenantId));
    const row = await this.repos.folders.create(tenantId, { name: input.name, parentFolderId, projectId });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'folder.created',
      resourceType: 'folder',
      resourceId: row.id,
      ip: actor.ip,
    });
    return toDTO(row, []);
  }

  async update(tenantId: string, id: string, input: FolderUpdateInput, actor: Actor): Promise<FolderDTO> {
    const current = await this.require(tenantId, id);
    let tagIds: string[] | undefined;
    if (input.tagIds !== undefined) {
      tagIds = [...new Set(input.tagIds)];
      const existing = await this.repos.tags.existing(tenantId, tagIds);
      if (existing.length !== tagIds.length) throw ApiError.notFound('Tag');
    }
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const parentId = input.parentFolderId;
      if (parentId !== undefined && parentId !== null) {
        // One move at a time per tenant: the check below and the update see the same tree, so two
        // moves at the same time cannot each pass and then close a loop together.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`folders:${tenantId}`}))`);
        await assertFolderInTenant(repos, tenantId, parentId);
        // P6-26: a folder moves only inside its project (moving across projects is the transfer route)
        const parentRow = await repos.folders.get(tenantId, parentId);
        if (parentRow && parentRow.projectId !== current.projectId) {
          throw ApiError.badRequest('A folder can only be moved inside its own project.');
        }
        const below = await repos.folders.subtreeIds(tenantId, id);
        if (below.includes(parentId)) {
          throw ApiError.badRequest('A folder cannot be moved into itself or one of its subfolders.');
        }
      }
      const updated = await repos.folders.update(tenantId, id, {
        name: input.name,
        parentFolderId: input.parentFolderId,
      });
      if (!updated) throw ApiError.notFound('Folder');
      if (tagIds) await repos.folders.setTags(tenantId, id, tagIds);
      return updated;
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'folder.updated',
      resourceType: 'folder',
      resourceId: id,
      metadata: {
        renamed: input.name !== undefined && input.name !== current.name,
        moved: input.parentFolderId !== undefined && input.parentFolderId !== current.parentFolderId,
        tagsChanged: tagIds !== undefined,
      },
      ip: actor.ip,
    });
    return this.dto(tenantId, row);
  }

  /**
   * Omitted `transferToFolderId`: every workflow in the folder and below goes to the root and is
   * archived (published ones are unpublished first), then the folder and its subfolders are
   * deleted. A folder id or 'root': the folder's workflows and direct subfolders move there in one
   * transaction and the folder is deleted.
   */
  async delete(tenantId: string, id: string, input: FolderDeleteInput, actor: Actor): Promise<void> {
    const current = await this.require(tenantId, id);
    const subtree = await this.repos.folders.subtreeIds(tenantId, id);
    const transfer = input.transferToFolderId;
    const target = transfer === undefined ? undefined : transfer === 'root' ? null : transfer;
    if (target) {
      await assertFolderInTenant(this.repos, tenantId, target);
      // P6-26: the workflows and subfolders move only inside the folder's project
      const targetRow = await this.repos.folders.get(tenantId, target);
      if (targetRow && targetRow.projectId !== current.projectId) {
        throw ApiError.badRequest('The workflows can only be moved to a folder of the same project.');
      }
      if (subtree.includes(target)) {
        throw ApiError.badRequest('The workflows cannot be moved into the folder that is being deleted.');
      }
    }
    if (target === undefined) {
      const { workflowArchive } = this.deps.context();
      for (const workflow of await this.repos.folders.workflowsIn(tenantId, subtree)) {
        if (!workflow.isArchived) {
          await workflowArchive.archive(tenantId, workflow.id, actor, { publicApi: true });
        }
      }
    }
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      if (target === undefined) {
        await repos.folders.moveWorkflows(tenantId, subtree, null);
      } else {
        await repos.folders.moveWorkflows(tenantId, [id], target);
        await repos.folders.reparentChildren(tenantId, id, target);
      }
      const gone = target === undefined ? subtree : [id];
      for (const folderId of gone) await repos.favorites.removeForResource(tenantId, 'folder', folderId);
      await repos.folders.delete(tenantId, id);
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'folder.deleted',
      resourceType: 'folder',
      resourceId: id,
      metadata: { transferToFolderId: transfer ?? null, folders: subtree.length },
      ip: actor.ip,
    });
  }
}
