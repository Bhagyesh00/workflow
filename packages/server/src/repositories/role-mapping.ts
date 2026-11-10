/**
 * P6-11 (L9): role mapping rules (`role_mapping_rules`, `role_mapping_rule_projects`), unique order per
 * (tenant, type). Every query filters `tenant_id` with a bound value. A write that changes orders runs under
 * one advisory lock per (workspace, type), and a move shifts the orders in two steps (to negative values
 * first), because the unique key on `order` is not deferrable.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type RoleMappingRuleRow,
  roleMappingRuleProjects,
  roleMappingRules,
} from '../db/schema';
import { isUuid } from './util';

export type RoleMappingRuleType = RoleMappingRuleRow['type'];

/** a rule with the projects it applies to (a project rule) */
export type RoleMappingRuleRecord = RoleMappingRuleRow & { projectIds: string[] };

export interface RoleMappingRuleInput {
  type: RoleMappingRuleType;
  expression: string;
  role: string;
  /** project rules only; each must be a project of the same workspace (composite FK) */
  projectIds?: string[];
}

export class RoleMappingRepository {
  constructor(protected readonly db: DbOrTx) {}

  private async projectIdsOf(tenantId: string, ruleIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ruleIds.length === 0) return out;
    const rows = await this.db
      .select({ ruleId: roleMappingRuleProjects.ruleId, projectId: roleMappingRuleProjects.projectId })
      .from(roleMappingRuleProjects)
      .where(
        and(eq(roleMappingRuleProjects.tenantId, tenantId), inArray(roleMappingRuleProjects.ruleId, ruleIds)),
      )
      .orderBy(asc(roleMappingRuleProjects.projectId));
    for (const row of rows) out.set(row.ruleId, [...(out.get(row.ruleId) ?? []), row.projectId]);
    return out;
  }

  private async withProjects(tenantId: string, rows: RoleMappingRuleRow[]): Promise<RoleMappingRuleRecord[]> {
    const projects = await this.projectIdsOf(
      tenantId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, projectIds: projects.get(row.id) ?? [] }));
  }

  /** the workspace's rules, instance rules first, each type by order */
  async list(tenantId: string, type?: RoleMappingRuleType): Promise<RoleMappingRuleRecord[]> {
    const rows = await this.db
      .select()
      .from(roleMappingRules)
      .where(
        and(eq(roleMappingRules.tenantId, tenantId), type ? eq(roleMappingRules.type, type) : undefined),
      )
      // 'instance' sorts before 'project'
      .orderBy(asc(roleMappingRules.type), asc(roleMappingRules.order));
    return this.withProjects(tenantId, rows);
  }

  async get(tenantId: string, id: string): Promise<RoleMappingRuleRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.id, id)));
    return row ? (await this.withProjects(tenantId, [row]))[0] : undefined;
  }

  /** one lock per (workspace, type) for the rest of the transaction */
  private async lock(tx: DbOrTx, tenantId: string, type: RoleMappingRuleType): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`role-mapping:${tenantId}:${type}`}, 0))`);
  }

  /** ids of one type in their order */
  private async idsInOrder(tx: DbOrTx, tenantId: string, type: RoleMappingRuleType): Promise<string[]> {
    const rows = await tx
      .select({ id: roleMappingRules.id })
      .from(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.type, type)))
      .orderBy(asc(roleMappingRules.order));
    return rows.map((row) => row.id);
  }

  /** writes the sequence `ids` as orders 0..n-1: first all to negative values, then to the final ones */
  private async renumber(tx: DbOrTx, tenantId: string, type: RoleMappingRuleType, ids: string[]): Promise<void> {
    await tx
      .update(roleMappingRules)
      .set({ order: sql`-(${roleMappingRules.order}) - 1` })
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.type, type)));
    for (const [index, id] of ids.entries()) {
      await tx
        .update(roleMappingRules)
        .set({ order: index })
        .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.id, id)));
    }
  }

  private async setProjects(
    tx: DbOrTx,
    tenantId: string,
    ruleId: string,
    projectIds: string[],
  ): Promise<void> {
    await tx
      .delete(roleMappingRuleProjects)
      .where(and(eq(roleMappingRuleProjects.tenantId, tenantId), eq(roleMappingRuleProjects.ruleId, ruleId)));
    const unique = [...new Set(projectIds)];
    if (unique.length > 0) {
      await tx
        .insert(roleMappingRuleProjects)
        .values(unique.map((projectId) => ({ tenantId, ruleId, projectId })));
    }
  }

  /** appended after the last rule of its type unless `order` is given (clamped into the list; the rest shift) */
  async create(
    tenantId: string,
    input: RoleMappingRuleInput & { order?: number },
  ): Promise<RoleMappingRuleRecord> {
    const id = await this.db.transaction(async (tx) => {
      await this.lock(tx, tenantId, input.type);
      const ids = await this.idsInOrder(tx, tenantId, input.type);
      const [row] = await tx
        .insert(roleMappingRules)
        // the highest order + 1 can never collide, even with gaps left by deleted rules
        .values({
          tenantId,
          type: input.type,
          expression: input.expression,
          role: input.role,
          order: await this.nextOrder(tx, tenantId, input.type),
        })
        .returning();
      if (input.projectIds) await this.setProjects(tx, tenantId, row.id, input.projectIds);
      const at = Math.max(0, Math.min(input.order ?? ids.length, ids.length));
      if (input.order !== undefined && at < ids.length) {
        const sequence = [...ids];
        sequence.splice(at, 0, row.id);
        await this.renumber(tx, tenantId, input.type, sequence);
      }
      return row.id;
    });
    return (await this.get(tenantId, id)) as RoleMappingRuleRecord;
  }

  private async nextOrder(tx: DbOrTx, tenantId: string, type: RoleMappingRuleType): Promise<number> {
    const [row] = await tx
      .select({ top: sql<number>`coalesce(max(${roleMappingRules.order}), -1)` })
      .from(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.type, type)));
    return Number(row?.top ?? -1) + 1;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<RoleMappingRuleInput>,
  ): Promise<RoleMappingRuleRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const found = await this.db.transaction(async (tx) => {
      const changes: Partial<typeof roleMappingRules.$inferInsert> = { updatedAt: new Date() };
      if (patch.expression !== undefined) changes.expression = patch.expression;
      if (patch.role !== undefined) changes.role = patch.role;
      const rows = await tx
        .update(roleMappingRules)
        .set(changes)
        .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.id, id)))
        .returning({ id: roleMappingRules.id });
      if (rows.length === 0) return false;
      if (patch.projectIds !== undefined) await this.setProjects(tx, tenantId, id, patch.projectIds);
      return true;
    });
    return found ? this.get(tenantId, id) : undefined;
  }

  /** moves the rule to `order` within its type, shifting the others (two steps in one transaction) */
  async move(tenantId: string, id: string, order: number): Promise<RoleMappingRuleRecord | undefined> {
    const current = await this.get(tenantId, id);
    if (!current) return undefined;
    await this.db.transaction(async (tx) => {
      await this.lock(tx, tenantId, current.type);
      const ids = (await this.idsInOrder(tx, tenantId, current.type)).filter((other) => other !== id);
      const at = Math.max(0, Math.min(Math.trunc(order), ids.length));
      ids.splice(at, 0, id);
      await this.renumber(tx, tenantId, current.type, ids);
      await tx
        .update(roleMappingRules)
        .set({ updatedAt: new Date() })
        .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.id, id)));
    });
    return this.get(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.id, id)))
      .returning({ id: roleMappingRules.id });
    return rows.length > 0;
  }

  /** deletes every rule of one type (project management turned off) */
  async deleteByType(tenantId: string, type: RoleMappingRuleType): Promise<number> {
    const rows = await this.db
      .delete(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.type, type)))
      .returning({ id: roleMappingRules.id });
    return rows.length;
  }

  /** the rules that assign a role (the 409 of a role delete names them) */
  async listByRole(tenantId: string, role: string): Promise<RoleMappingRuleRecord[]> {
    const rows = await this.db
      .select()
      .from(roleMappingRules)
      .where(and(eq(roleMappingRules.tenantId, tenantId), eq(roleMappingRules.role, role)))
      .orderBy(asc(roleMappingRules.type), asc(roleMappingRules.order));
    return this.withProjects(tenantId, rows);
  }
}
