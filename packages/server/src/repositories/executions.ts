/** Executions and their (separately stored) run data. */
import { and, count, desc, eq, inArray, lt, lte, notInArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type ExecutionDataRow, type ExecutionRow, executionData, executions } from '../db/schema';
import type { Cursor } from '../http/pagination';
import { type AnnotationVote, annotationConditions } from './annotations';
import { isUuid, now } from './util';

export type ExecutionInsert = Omit<typeof executions.$inferInsert, 'tenantId'>;

/** a JSON-escaped U+0000, unless its backslash is itself escaped (the text "\u0000" in the data) */
const ESCAPED_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g;
const NUL = '\0';
const REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * Postgres text and jsonb reject U+0000. Run data comes from untrusted payloads (webhook bodies,
 * HTTP responses), so every NUL, in keys and values alike, is replaced with U+FFFD before writing.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === 'string')
    return (value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value) as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const json = JSON.stringify(value);
  const cleaned = json.replace(ESCAPED_NUL, `$1${REPLACEMENT}`);
  return cleaned === json ? value : (JSON.parse(cleaned) as T);
}

function withoutNulFields<T extends Partial<ExecutionInsert>>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, withoutNul(value)])) as T;
}

export class ExecutionRepository {
  constructor(private readonly db: DbOrTx) {}

  /** the row and its data are written together, so a failed data insert leaves no orphan 'new' row */
  async create(
    tenantId: string,
    execution: ExecutionInsert,
    data: { workflowData: Record<string, unknown>; runOptions: Record<string, unknown> },
  ): Promise<ExecutionRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(executions)
        .values({ ...withoutNulFields(execution), tenantId, createdAt: now() })
        .returning();
      await tx.insert(executionData).values({
        executionId: row.id,
        tenantId,
        workflowData: withoutNul(data.workflowData),
        runOptions: withoutNul(data.runOptions),
        state: null,
      });
      return row;
    });
  }

  async get(tenantId: string, id: string): Promise<ExecutionRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.id, id)));
    return row;
  }

  /**
   * Resume webhooks (`/webhook-waiting/:executionId`) carry no tenant: the unguessable id is the
   * capability. Every follow-up query is scoped to the tenant of the row found here.
   */
  async findTenantOf(id: string): Promise<string | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select({ tenantId: executions.tenantId })
      .from(executions)
      .where(eq(executions.id, id));
    return row?.tenantId;
  }

  async getData(tenantId: string, id: string): Promise<ExecutionDataRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(executionData)
      .where(and(eq(executionData.tenantId, tenantId), eq(executionData.executionId, id)));
    return row;
  }

  async list(
    tenantId: string,
    filter: {
      workflowId?: string;
      status?: string[];
      /** P3-10: executions of one workflow version */
      workflowVersionId?: string;
      /** P3-09: annotation tag ids (any) and vote */
      annotationTags?: string[];
      vote?: AnnotationVote;
      limit: number;
      cursor?: Cursor;
    },
  ): Promise<ExecutionRow[]> {
    const conditions: SQL[] = [eq(executions.tenantId, tenantId)];
    if (filter.workflowId) {
      if (!isUuid(filter.workflowId)) return [];
      conditions.push(eq(executions.workflowId, filter.workflowId));
    }
    if (filter.status?.length) conditions.push(inArray(executions.status, filter.status));
    if (filter.workflowVersionId) {
      if (!isUuid(filter.workflowVersionId)) return [];
      conditions.push(eq(executions.workflowVersionId, filter.workflowVersionId));
    }
    conditions.push(...annotationConditions(tenantId, { tags: filter.annotationTags, vote: filter.vote }));
    if (filter.cursor) {
      if (!isUuid(filter.cursor.id)) return [];
      conditions.push(
        sql`(${executions.createdAt}, ${executions.id}) < (${filter.cursor.value}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    return this.db
      .select()
      .from(executions)
      .where(and(...conditions))
      .orderBy(desc(executions.createdAt), desc(executions.id))
      .limit(filter.limit + 1);
  }

  async update(tenantId: string, id: string, patch: Partial<ExecutionInsert>): Promise<void> {
    await this.db
      .update(executions)
      .set(withoutNulFields(patch))
      .where(and(eq(executions.tenantId, tenantId), eq(executions.id, id)));
  }

  /** atomic status transition; returns false when the row was not in one of `from` */
  async transition(
    tenantId: string,
    id: string,
    from: string[],
    patch: Partial<ExecutionInsert>,
  ): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .update(executions)
      .set(withoutNulFields(patch))
      .where(and(eq(executions.tenantId, tenantId), eq(executions.id, id), inArray(executions.status, from)))
      .returning({ id: executions.id });
    return rows.length > 0;
  }

  async saveState(tenantId: string, id: string, state: unknown): Promise<void> {
    await this.db
      .update(executionData)
      .set({ state: withoutNul(state as Record<string, unknown>) })
      .where(and(eq(executionData.tenantId, tenantId), eq(executionData.executionId, id)));
  }

  async updateRunOptions(tenantId: string, id: string, runOptions: Record<string, unknown>): Promise<void> {
    await this.db
      .update(executionData)
      .set({ runOptions: withoutNul(runOptions) })
      .where(and(eq(executionData.tenantId, tenantId), eq(executionData.executionId, id)));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.id, id)))
      .returning({ id: executions.id });
    return rows.length > 0;
  }

  async idsForWorkflow(tenantId: string, workflowId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.workflowId, workflowId)));
    return rows.map((r) => r.id);
  }

  async countRunning(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), inArray(executions.status, ['new', 'running'])));
    return Number(row?.n ?? 0);
  }

  /** system tooling (wait tracker): waiting executions whose time has come, across tenants */
  async listDueWaiting(until: Date, limit = 100): Promise<Array<{ id: string; tenantId: string }>> {
    return this.db
      .select({ id: executions.id, tenantId: executions.tenantId })
      .from(executions)
      .where(and(eq(executions.status, 'waiting'), lte(executions.waitTill, until)))
      .orderBy(executions.waitTill)
      .limit(limit);
  }

  /** system tooling (pruning): finished executions that stopped before `before` */
  async listPrunable(before: Date, limit: number, tenantId?: string) {
    const conditions = [
      lt(executions.stoppedAt, before),
      notInArray(executions.status, ['new', 'running', 'waiting']),
    ];
    if (tenantId) conditions.push(eq(executions.tenantId, tenantId));
    return this.db
      .select({ id: executions.id, tenantId: executions.tenantId })
      .from(executions)
      .where(and(...conditions))
      .limit(limit);
  }

  /** system tooling (pruning): tenants having executions that stopped before `before` */
  async tenantsWithFinishedBefore(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tenantId: executions.tenantId })
      .from(executions)
      .where(lt(executions.stoppedAt, before));
    return rows.map((r) => r.tenantId);
  }

  async deleteMany(tenantId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db
      .delete(executions)
      .where(and(eq(executions.tenantId, tenantId), inArray(executions.id, ids)));
  }

  /** system tooling (regular-mode startup): executions left running by a crashed process */
  async markCrashed(): Promise<ExecutionRow[]> {
    return this.db
      .update(executions)
      .set({
        status: 'crashed',
        stoppedAt: now(),
        errorMessage: 'The process stopped while the execution ran',
      })
      .where(inArray(executions.status, ['new', 'running']))
      .returning();
  }
}
