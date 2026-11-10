/** Executions and their (separately stored) run data. */

import type { RedactionChannels } from '@workflow/workflow';
import { and, count, desc, eq, inArray, lt, lte, ne, notInArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type ExecutionDataRow, type ExecutionRow, executionData, executions, workflows } from '../db/schema';
import type { Cursor } from '../http/pagination';
import { type AnnotationVote, annotationConditions } from './annotations';
import { type AccessListOptions, sharedRowConditions } from './shares';
import { isUuid, now } from './util';

/** LIKE wildcards and the escape character matched literally */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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

/**
 * P6-53 (S3): what the read side judges of one run without loading its state (`redactSummaries`, `/binary-data`)
 */
export interface ExecutionRedactionFacts {
  /** the redaction snapshot taken at start (`run_options.redaction`); null when the run kept none */
  redaction: (RedactionChannels & { reason?: string }) | null;
  /** the user who started the run (`run_options.userId`); null on a server path */
  userId: string | null;
  /** the credential ids the nodes of the run's workflow snapshot name (strings only, no repeats) */
  credentialIds: string[];
  /** P6-15 (S2): the run used a user's own connection of a private credential */
  usedPrivateCredentials: boolean;
}

export class ExecutionRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * P6-53 (S3): the redaction facts of a page of runs in one query (no `state` read), keyed by run id; an id
   * of another workspace or no run is absent. A run whose data row is gone keeps its row's facts.
   */
  async redactionFacts(
    tenantId: string,
    ids: readonly string[],
  ): Promise<Map<string, ExecutionRedactionFacts>> {
    const facts = new Map<string, ExecutionRedactionFacts>();
    const valid = [...new Set(ids.filter(isUuid))];
    if (!valid.length) return facts;
    const rows = await this.db
      .select({
        id: executions.id,
        usedPrivateCredentials: executions.usedPrivateCredentials,
        redaction: sql<unknown>`${executionData.runOptions} -> 'redaction'`,
        userId: sql<unknown>`${executionData.runOptions} ->> 'userId'`,
        credentialIds: sql<unknown>`jsonb_path_query_array(${executionData.workflowData}, '$.nodes[*].credentials.*.id')`,
      })
      .from(executions)
      .leftJoin(
        executionData,
        and(eq(executionData.executionId, executions.id), eq(executionData.tenantId, executions.tenantId)),
      )
      .where(and(eq(executions.tenantId, tenantId), inArray(executions.id, valid)));
    for (const row of rows) {
      const redaction =
        row.redaction && typeof row.redaction === 'object' && !Array.isArray(row.redaction)
          ? (row.redaction as ExecutionRedactionFacts['redaction'])
          : null;
      const credentialIds = Array.isArray(row.credentialIds)
        ? [...new Set(row.credentialIds.filter((id): id is string => typeof id === 'string' && id !== ''))]
        : [];
      facts.set(row.id, {
        redaction,
        userId: typeof row.userId === 'string' && row.userId !== '' ? row.userId : null,
        credentialIds,
        usedPrivateCredentials: row.usedPrivateCredentials,
      });
    }
    return facts;
  }

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
    /**
     * `AccessListOptions` (P6-25) go through the run's workflow: a run is listed when its workflow is; a
     * run with no workflow row (`workflow_id` null) only with `filter.all` or no filter. They AND with
     * every other condition, the custom data filter included.
     */
    filter: AccessListOptions & {
      workflowId?: string;
      status?: string[];
      /** P3-10: executions of one workflow version */
      workflowVersionId?: string;
      /** P3-09: annotation tag ids (any) and vote */
      annotationTags?: string[];
      vote?: AnnotationVote;
      /** P5-61: executions whose custom data has this key (with `customDataValue`: that value) */
      customDataKey?: string;
      customDataValue?: string;
      /** the whole value; otherwise a part of it (case-sensitive) */
      customDataExact?: boolean;
      limit: number;
      cursor?: Cursor;
    },
  ): Promise<ExecutionRow[]> {
    const access = sharedRowConditions({
      tenantId,
      kind: 'workflow',
      id: executions.workflowId,
      project: sql`(select ${workflows.projectId} from ${workflows} where ${workflows.id} = ${executions.workflowId} and ${workflows.tenantId} = ${tenantId}::uuid)`,
      options: filter,
    });
    if (!access) return [];
    const conditions: SQL[] = [eq(executions.tenantId, tenantId), ...access];
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
    if (filter.customDataKey) {
      const key = withoutNul(filter.customDataKey);
      conditions.push(sql`jsonb_exists(${executions.customData}, ${key})`);
      if (filter.customDataValue) {
        const value = withoutNul(filter.customDataValue);
        conditions.push(
          filter.customDataExact
            ? sql`(${executions.customData} ->> ${key}) = ${value}`
            : sql`(${executions.customData} ->> ${key}) LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`,
        );
      }
    }
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

  /** claims a waiting run only while it stands at this tool's wait: an answer checked against an earlier wait fails */
  async claimToolWait(
    tenantId: string,
    id: string,
    wait: { toolNode: string; toolRunIndex: number },
    patch: Partial<ExecutionInsert>,
  ): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .update(executions)
      .set(withoutNulFields(patch))
      .where(
        and(
          eq(executions.tenantId, tenantId),
          eq(executions.id, id),
          eq(executions.status, 'waiting'),
          sql`exists (select 1 from ${executionData} where ${executionData.tenantId} = ${executions.tenantId} and ${executionData.executionId} = ${executions.id} and ${executionData.state} #> '{executionData,suspended}' @> ${JSON.stringify(wait)}::jsonb)`,
        ),
      )
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

  /** the plan's concurrent count: evaluation cases are left out, the evaluation pool bounds them (n8n's separate queue) */
  async countRunning(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(executions)
      .where(
        and(
          eq(executions.tenantId, tenantId),
          inArray(executions.status, ['new', 'running']),
          ne(executions.mode, 'evaluation'),
        ),
      );
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
