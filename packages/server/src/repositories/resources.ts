/** Credentials, variables, webhooks, audit log, usage counters and webhook idempotency keys. */
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  auditLog,
  type CredentialRow,
  credentialShares,
  credentials,
  usageCounters,
  variables,
  type WebhookRow,
  webhookIdempotency,
  webhooks,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { type AccessListOptions, inUuids, sharedRowConditions } from './shares';
import { isUuid, now } from './util';

/** credential list options (P6-24): the access filter shape plus the type */
export interface CredentialListOptions extends AccessListOptions {
  type?: string;
}

/**
 * variable list options (P6-31). `projectId`: a project's variables; null: only workspace (global)
 * variables; absent: both. `filter` narrows the project variables to `filter.projectIds` (global ones stay,
 * `variable:list` is a workspace scope). Variables are never shared, so `onlySharedWithMe` matches nothing.
 */
export interface VariableListOptions extends Omit<AccessListOptions, 'projectId'> {
  projectId?: string | null;
}

export class CredentialRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * `options` as a string is the type alone (the callers from before P6-24). With an access filter a
   * credential is listed when its project or a share reaches it, or it is global and `filter.credentialIds`
   * holds it (`AccessService.listFilter` puts global ids there for `credential:list` and `:read`).
   */
  async list(tenantId: string, options?: CredentialListOptions | string) {
    const opts: CredentialListOptions = typeof options === 'string' ? { type: options } : (options ?? {});
    const access = sharedRowConditions({
      tenantId,
      kind: 'credential',
      id: credentials.id,
      project: credentials.projectId,
      options: opts,
    });
    if (!access) return [];
    const conditions = [eq(credentials.tenantId, tenantId), ...access];
    if (opts.type) conditions.push(eq(credentials.type, opts.type));
    return this.db
      .select({
        id: credentials.id,
        name: credentials.name,
        type: credentials.type,
        projectId: credentials.projectId,
        isGlobal: credentials.isGlobal,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
      })
      .from(credentials)
      .where(and(...conditions))
      .orderBy(asc(credentials.name), asc(credentials.id));
  }

  async get(tenantId: string, id: string): Promise<CredentialRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)));
    return row;
  }

  /** the owner and global flag of each credential in `ids` that exists in the tenant (no data) */
  async listByIds(
    tenantId: string,
    ids: string[],
  ): Promise<Array<{ id: string; projectId: string; isGlobal: boolean }>> {
    const valid = [...new Set(ids.filter(isUuid))];
    if (!valid.length) return [];
    return this.db
      .select({ id: credentials.id, projectId: credentials.projectId, isGlobal: credentials.isGlobal })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), inArray(credentials.id, valid)));
  }

  /**
   * A credential by exact name among `types`. With a `projectId` only what that project can use: owned by
   * it, shared with it, or global (P6-24), the project's own first. `null` searches the whole workspace,
   * the behaviour before P6-24 (L4 passes the project).
   */
  async findByName(
    tenantId: string,
    projectId: string | null,
    name: string,
    types: string[],
  ): Promise<CredentialRow | undefined> {
    if (!types.length) return undefined;
    const conditions: SQL[] = [
      eq(credentials.tenantId, tenantId),
      eq(credentials.name, name),
      inArray(credentials.type, types),
    ];
    const order: SQL[] = [];
    if (projectId !== null) {
      if (!isUuid(projectId)) return undefined;
      const owned = eq(credentials.projectId, projectId);
      conditions.push(
        sql`(${owned} or ${credentials.isGlobal} = true or ${credentials.id} in (select ${credentialShares.credentialId} from ${credentialShares} where ${credentialShares.tenantId} = ${tenantId}::uuid and ${inUuids(credentialShares.projectId, [projectId])}))`,
      );
      order.push(sql`(${owned}) desc`);
    }
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(...conditions))
      .orderBy(...order, asc(credentials.createdAt), asc(credentials.id))
      .limit(1);
    return row;
  }

  async create(
    tenantId: string,
    input: {
      id: string;
      name: string;
      type: string;
      dataEnc: string;
      createdBy?: string;
      /** the owning project (P6-24) */
      projectId: string;
      /** usable by every project of the workspace (`credential:shareGlobally`) */
      isGlobal?: boolean;
    },
  ) {
    const [row] = await this.db
      .insert(credentials)
      .values({ ...input, tenantId, createdAt: now(), updatedAt: now() })
      .returning();
    return row;
  }

  /** `projectId` moves the credential (P6-30; its shares are the caller's); `isGlobal` (P6-29) */
  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; dataEnc?: string; isGlobal?: boolean; projectId?: string },
  ) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(credentials)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)))
      .returning();
    return row;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(credentials)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, id)))
      .returning({ id: credentials.id });
    return rows.length > 0;
  }
}

export class VariableRepository {
  constructor(private readonly db: DbOrTx) {}

  async list(tenantId: string, options: VariableListOptions = {}) {
    if (options.onlySharedWithMe) return [];
    const conditions: SQL[] = [eq(variables.tenantId, tenantId)];
    if (options.projectId === null) conditions.push(isNull(variables.projectId));
    else if (options.projectId !== undefined) {
      if (!isUuid(options.projectId)) return [];
      conditions.push(eq(variables.projectId, options.projectId));
    }
    const { filter } = options;
    if (filter && !filter.all) {
      const projectIds = [...new Set(filter.projectIds.filter(isUuid))];
      const global = isNull(variables.projectId);
      conditions.push(
        projectIds.length ? sql`(${global} or ${inUuids(variables.projectId, projectIds)})` : global,
      );
    }
    return this.db
      .select()
      .from(variables)
      .where(and(...conditions))
      .orderBy(asc(variables.key), sql`${variables.projectId} nulls first`, asc(variables.id));
  }

  /**
   * `$vars` for a run: the workspace (global) variables, with the project's own value winning for a key
   * both have (P6-31). Without a project, only the workspace variables.
   */
  async map(tenantId: string, projectId?: string): Promise<Record<string, string>> {
    const scope =
      projectId !== undefined && isUuid(projectId)
        ? or(isNull(variables.projectId), eq(variables.projectId, projectId))
        : isNull(variables.projectId);
    const rows = await this.db
      .select({ key: variables.key, value: variables.value, projectId: variables.projectId })
      .from(variables)
      .where(and(eq(variables.tenantId, tenantId), scope));
    const out: Record<string, string> = {};
    for (const row of rows) if (row.projectId === null) out[row.key] = row.value;
    for (const row of rows) if (row.projectId !== null) out[row.key] = row.value;
    return out;
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(variables)
      .where(and(eq(variables.tenantId, tenantId), eq(variables.id, id)));
    return row;
  }

  /** `projectId` absent or null: a workspace (global) variable; keys are unique per project and globally */
  async create(tenantId: string, input: { key: string; value: string; projectId?: string | null }) {
    const [row] = await this.db
      .insert(variables)
      .values({
        tenantId,
        key: input.key,
        value: input.value,
        projectId: input.projectId ?? null,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    return row;
  }

  async update(tenantId: string, id: string, patch: { key?: string; value?: string }) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(variables)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(variables.tenantId, tenantId), eq(variables.id, id)))
      .returning();
    return row;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(variables)
      .where(and(eq(variables.tenantId, tenantId), eq(variables.id, id)))
      .returning({ id: variables.id });
    return rows.length > 0;
  }
}

export class WebhookRepository {
  constructor(private readonly db: DbOrTx) {}

  async listForWorkflow(tenantId: string, workflowId: string): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.workflowId, workflowId)));
  }

  async findStatic(tenantId: string, method: string, path: string): Promise<WebhookRow | undefined> {
    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(
        and(
          eq(webhooks.tenantId, tenantId),
          eq(webhooks.method, method),
          eq(webhooks.path, path),
          eq(webhooks.isDynamic, false),
        ),
      );
    return row;
  }

  async listDynamic(tenantId: string, method: string, segments: number): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(webhooks)
      .where(
        and(
          eq(webhooks.tenantId, tenantId),
          eq(webhooks.method, method),
          eq(webhooks.isDynamic, true),
          eq(webhooks.segments, segments),
        ),
      );
  }

  /** every method registered for a path (CORS preflight) */
  async methodsForPath(tenantId: string, path: string): Promise<string[]> {
    const rows = await this.db
      .select({ method: webhooks.method })
      .from(webhooks)
      .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.path, path)));
    return rows.map((r) => r.method);
  }

  async findConflicts(tenantId: string, workflowId: string, keys: Array<{ method: string; path: string }>) {
    if (!keys.length) return [];
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(
        and(
          eq(webhooks.tenantId, tenantId),
          inArray(
            sql`(${webhooks.method} || ' ' || ${webhooks.path})`,
            keys.map((k) => `${k.method} ${k.path}`),
          ),
        ),
      );
    return rows.filter((r) => r.workflowId !== workflowId);
  }

  async replaceForWorkflow(
    tenantId: string,
    workflowId: string,
    rows: Array<Omit<WebhookRow, 'tenantId' | 'workflowId'>>,
  ): Promise<void> {
    await this.deleteForWorkflow(tenantId, workflowId);
    if (rows.length) {
      await this.db.insert(webhooks).values(rows.map((r) => ({ ...r, tenantId, workflowId })));
    }
  }

  async deleteForWorkflow(tenantId: string, workflowId: string): Promise<void> {
    await this.db
      .delete(webhooks)
      .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.workflowId, workflowId)));
  }
}

export interface AuditEntry {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export class AuditRepository {
  constructor(private readonly db: DbOrTx) {}

  async add(tenantId: string, entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      tenantId,
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      metadata: entry.metadata ?? {},
      ip: entry.ip,
      createdAt: now(),
    });
  }

  async list(tenantId: string, limit: number, cursor?: Cursor) {
    const conditions = [eq(auditLog.tenantId, tenantId)];
    if (cursor) conditions.push(lt(auditLog.id, Number(cursor.id)));
    return this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);
  }
}

export class UsageRepository {
  constructor(private readonly db: DbOrTx) {}

  async increment(tenantId: string, period: string, executions: number, executionMs: number): Promise<void> {
    await this.db
      .insert(usageCounters)
      .values({ tenantId, period, executions, executionMs })
      .onConflictDoUpdate({
        target: [usageCounters.tenantId, usageCounters.period],
        set: {
          executions: sql`${usageCounters.executions} + ${executions}`,
          executionMs: sql`${usageCounters.executionMs} + ${executionMs}`,
        },
      });
  }

  async get(tenantId: string, period: string) {
    const [row] = await this.db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.period, period)));
    return row ?? { tenantId, period, executions: 0, executionMs: 0 };
  }
}

export class IdempotencyRepository {
  constructor(private readonly db: DbOrTx) {}

  /** claim a key; returns false when it already exists */
  async claim(tenantId: string, workflowId: string, key: string): Promise<boolean> {
    const rows = await this.db
      .insert(webhookIdempotency)
      .values({ tenantId, workflowId, key, createdAt: now() })
      .onConflictDoNothing()
      .returning({ key: webhookIdempotency.key });
    return rows.length > 0;
  }

  async get(tenantId: string, workflowId: string, key: string) {
    const [row] = await this.db
      .select()
      .from(webhookIdempotency)
      .where(
        and(
          eq(webhookIdempotency.tenantId, tenantId),
          eq(webhookIdempotency.workflowId, workflowId),
          eq(webhookIdempotency.key, key),
        ),
      );
    return row;
  }

  async complete(
    tenantId: string,
    workflowId: string,
    key: string,
    executionId: string | null,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(webhookIdempotency)
      .set({ executionId, response })
      .where(
        and(
          eq(webhookIdempotency.tenantId, tenantId),
          eq(webhookIdempotency.workflowId, workflowId),
          eq(webhookIdempotency.key, key),
        ),
      );
  }

  async release(tenantId: string, workflowId: string, key: string): Promise<void> {
    await this.db
      .delete(webhookIdempotency)
      .where(
        and(
          eq(webhookIdempotency.tenantId, tenantId),
          eq(webhookIdempotency.workflowId, workflowId),
          eq(webhookIdempotency.key, key),
        ),
      );
  }

  /** system tooling: drop keys older than `before` */
  async prune(before: Date): Promise<number> {
    const rows = await this.db
      .delete(webhookIdempotency)
      .where(lt(webhookIdempotency.createdAt, before))
      .returning({ key: webhookIdempotency.key });
    return rows.length;
  }
}
