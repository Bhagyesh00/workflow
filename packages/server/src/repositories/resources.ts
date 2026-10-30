/** Credentials, variables, webhooks, audit log, usage counters and webhook idempotency keys. */
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  auditLog,
  type CredentialRow,
  credentials,
  usageCounters,
  variables,
  type WebhookRow,
  webhookIdempotency,
  webhooks,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { isUuid, now } from './util';

export class CredentialRepository {
  constructor(private readonly db: DbOrTx) {}

  async list(tenantId: string, type?: string) {
    const conditions = [eq(credentials.tenantId, tenantId)];
    if (type) conditions.push(eq(credentials.type, type));
    return this.db
      .select({
        id: credentials.id,
        name: credentials.name,
        type: credentials.type,
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

  async findByName(tenantId: string, name: string, types: string[]): Promise<CredentialRow | undefined> {
    if (!types.length) return undefined;
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.tenantId, tenantId), eq(credentials.name, name), inArray(credentials.type, types)),
      )
      .limit(1);
    return row;
  }

  async create(
    tenantId: string,
    input: { id: string; name: string; type: string; dataEnc: string; createdBy?: string },
  ) {
    const [row] = await this.db
      .insert(credentials)
      .values({ ...input, tenantId, createdAt: now(), updatedAt: now() })
      .returning();
    return row;
  }

  async update(tenantId: string, id: string, patch: { name?: string; dataEnc?: string }) {
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

  async list(tenantId: string) {
    return this.db
      .select()
      .from(variables)
      .where(eq(variables.tenantId, tenantId))
      .orderBy(asc(variables.key));
  }

  async map(tenantId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({ key: variables.key, value: variables.value })
      .from(variables)
      .where(eq(variables.tenantId, tenantId));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(variables)
      .where(and(eq(variables.tenantId, tenantId), eq(variables.id, id)));
    return row;
  }

  async create(tenantId: string, key: string, value: string) {
    const [row] = await this.db
      .insert(variables)
      .values({ tenantId, key, value, createdAt: now(), updatedAt: now() })
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
