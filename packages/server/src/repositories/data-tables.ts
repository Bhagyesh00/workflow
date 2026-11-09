/**
 * Data tables (P4-03). Every query filters tenant_id, and filter values are bound parameters: a
 * column name is never SQL text. Conditions come from services/data-table-filter.ts.
 */
import { randomUUID } from 'node:crypto';
import { type AnyColumn, and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type DataTableColumnRow,
  type DataTableRow,
  type DataTableRowRow,
  dataTableColumns,
  dataTableRows,
  dataTables,
  workflows,
} from '../db/schema';
import { rowSizeSql } from '../services/data-table-size';
import { type AccessListOptions, projectRowConditions } from './shares';
import { isUuid, now } from './util';

/** rows per INSERT; about 5 bound values each, well under Postgres' 65535 */
const INSERT_BATCH = 1000;
/** the Data Table node, and the tool the agent nodes make of it */
const DATA_TABLE_NODE_TYPES = ['core.dataTable', 'core.dataTableTool'];

/** with `AccessListOptions` (P6-23): a data table belongs to one project and is never shared */
export interface DataTableListOptions extends AccessListOptions {
  name?: string;
  sortBy?: { column: 'name' | 'createdAt' | 'updatedAt' | 'size'; direction: 'asc' | 'desc' };
  take: number;
  skip: number;
}

export interface DataTableRowListOptions {
  conditions?: Array<SQL | undefined>;
  orderBy: SQL[];
  /** absent = every row (the CSV download) */
  take?: number;
  skip?: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class DataTableRepository {
  constructor(readonly db: DbOrTx) {}

  async get(tenantId: string, id: string): Promise<DataTableRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(dataTables)
      .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)));
    return row;
  }

  /** exact name, inside one project (names are unique per project, not per workspace) */
  async getByName(tenantId: string, projectId: string, name: string): Promise<DataTableRow | undefined> {
    if (!isUuid(projectId)) return undefined;
    const [row] = await this.db
      .select()
      .from(dataTables)
      .where(
        and(
          eq(dataTables.tenantId, tenantId),
          eq(dataTables.projectId, projectId),
          eq(dataTables.name, name),
        ),
      );
    return row;
  }

  /** the table, held until the transaction ends, so column changes of one table run one at a time */
  async lock(tenantId: string, id: string): Promise<DataTableRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(dataTables)
      .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)))
      .for('update');
    return row;
  }

  async list(
    tenantId: string,
    options: DataTableListOptions,
  ): Promise<{ count: number; rows: DataTableRow[] }> {
    const access = projectRowConditions(dataTables.projectId, options);
    if (!access) return { count: 0, rows: [] };
    const conditions = [eq(dataTables.tenantId, tenantId), ...access];
    if (options.name) {
      conditions.push(sql`${dataTables.name} ilike ${`%${escapeLike(options.name)}%`}`);
    }
    const where = and(...conditions);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(dataTables)
      .where(where);
    const sort = options.sortBy ?? { column: 'updatedAt', direction: 'desc' };
    const byDirection = (column: SQL | AnyColumn) => (sort.direction === 'desc' ? desc(column) : asc(column));
    if (sort.column === 'size') {
      // the size is the sum of the row sizes, as tableSizes counts it; an empty table is 0
      const size = sql<string>`coalesce(sum(${dataTableRows.sizeBytes}), 0)`;
      const sized = await this.db
        .select({ table: dataTables })
        .from(dataTables)
        .leftJoin(
          dataTableRows,
          and(eq(dataTableRows.tenantId, dataTables.tenantId), eq(dataTableRows.tableId, dataTables.id)),
        )
        .where(where)
        .groupBy(dataTables.id)
        .orderBy(byDirection(size), asc(dataTables.id))
        .limit(options.take)
        .offset(options.skip);
      return { count, rows: sized.map((row) => row.table) };
    }
    const columns = {
      name: dataTables.name,
      createdAt: dataTables.createdAt,
      updatedAt: dataTables.updatedAt,
    };
    const rows = await this.db
      .select()
      .from(dataTables)
      .where(where)
      .orderBy(byDirection(columns[sort.column]), asc(dataTables.id))
      .limit(options.take)
      .offset(options.skip);
    return { count, rows };
  }

  /** names are unique per project (a taken name is a unique violation) */
  async create(tenantId: string, projectId: string, name: string): Promise<DataTableRow> {
    const [row] = await this.db.insert(dataTables).values({ tenantId, projectId, name }).returning();
    return row;
  }

  async rename(tenantId: string, id: string, name: string): Promise<DataTableRow | undefined> {
    const [row] = await this.db
      .update(dataTables)
      .set({ name, updatedAt: now() })
      .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)))
      .returning();
    return row;
  }

  async touch(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(dataTables)
      .set({ updatedAt: now() })
      .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)));
  }

  /** columns and rows go with it (foreign keys) */
  async delete(tenantId: string, id: string): Promise<void> {
    await this.db.delete(dataTables).where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)));
  }

  /** takes `count` row ids in one step; the row stays locked until the transaction ends */
  async reserveRowIds(tenantId: string, id: string, count: number): Promise<number> {
    const [row] = await this.db
      .update(dataTables)
      .set({ nextRowId: sql`${dataTables.nextRowId} + ${count}::bigint`, updatedAt: now() })
      .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.id, id)))
      .returning({ next: dataTables.nextRowId });
    return row.next - count;
  }

  // ---- columns ----

  /** by position */
  async listColumns(tenantId: string, tableId: string): Promise<DataTableColumnRow[]> {
    if (!isUuid(tableId)) return [];
    return this.db
      .select()
      .from(dataTableColumns)
      .where(and(eq(dataTableColumns.tenantId, tenantId), eq(dataTableColumns.tableId, tableId)))
      .orderBy(asc(dataTableColumns.position));
  }

  /** the columns of many tables, by position */
  async listColumnsOf(tenantId: string, tableIds: string[]): Promise<DataTableColumnRow[]> {
    if (!tableIds.length) return [];
    return this.db
      .select()
      .from(dataTableColumns)
      .where(and(eq(dataTableColumns.tenantId, tenantId), inArray(dataTableColumns.tableId, tableIds)))
      .orderBy(asc(dataTableColumns.position));
  }

  async addColumn(
    tenantId: string,
    tableId: string,
    input: { name: string; type: DataTableColumnRow['type']; position: number },
  ): Promise<DataTableColumnRow> {
    const [row] = await this.db
      .insert(dataTableColumns)
      .values({ id: randomUUID(), tenantId, tableId, ...input })
      .returning();
    return row;
  }

  async setColumnPosition(
    tenantId: string,
    tableId: string,
    columnId: string,
    position: number,
  ): Promise<void> {
    await this.db
      .update(dataTableColumns)
      .set({ position, updatedAt: now() })
      .where(
        and(
          eq(dataTableColumns.tenantId, tenantId),
          eq(dataTableColumns.tableId, tableId),
          eq(dataTableColumns.id, columnId),
        ),
      );
  }

  async renameColumn(
    tenantId: string,
    tableId: string,
    columnId: string,
    name: string,
  ): Promise<DataTableColumnRow | undefined> {
    const [row] = await this.db
      .update(dataTableColumns)
      .set({ name, updatedAt: now() })
      .where(
        and(
          eq(dataTableColumns.tenantId, tenantId),
          eq(dataTableColumns.tableId, tableId),
          eq(dataTableColumns.id, columnId),
        ),
      )
      .returning();
    return row;
  }

  async deleteColumn(tenantId: string, tableId: string, columnId: string): Promise<void> {
    await this.db
      .delete(dataTableColumns)
      .where(
        and(
          eq(dataTableColumns.tenantId, tenantId),
          eq(dataTableColumns.tableId, tableId),
          eq(dataTableColumns.id, columnId),
        ),
      );
  }

  /** moves a cell key in every row of the table; `updated_at` stays, no cell changed */
  async renameRowKey(tenantId: string, tableId: string, from: string, to: string): Promise<void> {
    const moved = sql`(${dataTableRows.data} - ${from}::text) || jsonb_build_object(${to}::text, ${dataTableRows.data} -> ${from}::text)`;
    await this.db
      .update(dataTableRows)
      .set({ data: moved, sizeBytes: rowSizeSql(moved) })
      .where(
        and(
          eq(dataTableRows.tenantId, tenantId),
          eq(dataTableRows.tableId, tableId),
          sql`jsonb_exists(${dataTableRows.data}, ${from}::text)`,
        ),
      );
  }

  /** removes a cell key from every row of the table */
  async deleteRowKey(tenantId: string, tableId: string, key: string): Promise<void> {
    const stripped = sql`${dataTableRows.data} - ${key}::text`;
    await this.db
      .update(dataTableRows)
      .set({ data: stripped, sizeBytes: rowSizeSql(stripped) })
      .where(
        and(
          eq(dataTableRows.tenantId, tenantId),
          eq(dataTableRows.tableId, tableId),
          sql`jsonb_exists(${dataTableRows.data}, ${key}::text)`,
        ),
      );
  }

  // ---- rows ----

  private rowsWhere(tenantId: string, tableId: string, conditions: Array<SQL | undefined> = []) {
    return and(eq(dataTableRows.tenantId, tenantId), eq(dataTableRows.tableId, tableId), ...conditions);
  }

  async listRows(
    tenantId: string,
    tableId: string,
    options: DataTableRowListOptions,
  ): Promise<DataTableRowRow[]> {
    const query = this.db
      .select()
      .from(dataTableRows)
      .where(this.rowsWhere(tenantId, tableId, options.conditions))
      .orderBy(...options.orderBy)
      .$dynamic();
    if (options.take !== undefined) query.limit(options.take);
    if (options.skip !== undefined) query.offset(options.skip);
    return query;
  }

  async countRows(tenantId: string, tableId: string, conditions?: Array<SQL | undefined>): Promise<number> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(dataTableRows)
      .where(this.rowsWhere(tenantId, tableId, conditions));
    return count;
  }

  async rowExists(tenantId: string, tableId: string, condition: SQL | undefined): Promise<boolean> {
    const found = await this.db
      .select({ one: sql`1` })
      .from(dataTableRows)
      .where(this.rowsWhere(tenantId, tableId, [condition]))
      .limit(1);
    return found.length > 0;
  }

  /** ids run from `firstRowId`, in the order given */
  async insertRows(
    tenantId: string,
    tableId: string,
    firstRowId: number,
    cells: Array<Record<string, unknown>>,
  ): Promise<DataTableRowRow[]> {
    const out: DataTableRowRow[] = [];
    for (let start = 0; start < cells.length; start += INSERT_BATCH) {
      const values = cells.slice(start, start + INSERT_BATCH).map((data, index) => ({
        tenantId,
        tableId,
        rowId: firstRowId + start + index,
        data,
        sizeBytes: rowSizeSql(sql`${JSON.stringify(data)}::jsonb`),
      }));
      out.push(...(await this.db.insert(dataTableRows).values(values).returning()));
    }
    return out.sort((a, b) => a.rowId - b.rowId);
  }

  /** merges `patch` into every matching row */
  async updateRows(
    tenantId: string,
    tableId: string,
    condition: SQL | undefined,
    patch: Record<string, unknown>,
  ): Promise<DataTableRowRow[]> {
    const merged = sql`${dataTableRows.data} || ${JSON.stringify(patch)}::jsonb`;
    const rows = await this.db
      .update(dataTableRows)
      .set({ data: merged, sizeBytes: rowSizeSql(merged), updatedAt: now() })
      .where(this.rowsWhere(tenantId, tableId, [condition]))
      .returning();
    return rows.sort((a, b) => a.rowId - b.rowId);
  }

  async deleteRows(
    tenantId: string,
    tableId: string,
    condition: SQL | undefined,
  ): Promise<DataTableRowRow[]> {
    const rows = await this.db
      .delete(dataTableRows)
      .where(this.rowsWhere(tenantId, tableId, [condition]))
      .returning();
    return rows.sort((a, b) => a.rowId - b.rowId);
  }

  /** every row of the table; next_row_id stays, so an id is never used twice */
  async clearRows(tenantId: string, tableId: string): Promise<number> {
    const rows = await this.db
      .delete(dataTableRows)
      .where(this.rowsWhere(tenantId, tableId))
      .returning({ rowId: dataTableRows.rowId });
    return rows.length;
  }

  // ---- size and use ----

  /** SUM(size_bytes) of the workspace, for the quota */
  async totalSizeBytes(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${dataTableRows.sizeBytes}), 0)` })
      .from(dataTableRows)
      .where(eq(dataTableRows.tenantId, tenantId));
    return Number(row.total);
  }

  /** every table of the workspace with its size */
  async tableSizes(
    tenantId: string,
  ): Promise<Array<{ id: string; name: string; projectId: string; sizeBytes: number }>> {
    const rows = await this.db
      .select({
        id: dataTables.id,
        name: dataTables.name,
        projectId: dataTables.projectId,
        sizeBytes: sql<string>`coalesce(sum(${dataTableRows.sizeBytes}), 0)`,
      })
      .from(dataTables)
      .leftJoin(
        dataTableRows,
        and(eq(dataTableRows.tenantId, dataTables.tenantId), eq(dataTableRows.tableId, dataTables.id)),
      )
      .where(eq(dataTables.tenantId, tenantId))
      .groupBy(dataTables.id, dataTables.name, dataTables.projectId);
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }

  /**
   * workflows with a Data Table node that names this table by id (list and id modes) or by name; only the
   * workflows of the table's project, since a node reaches only its own project's tables (P6-23)
   */
  async dependentWorkflows(
    tenantId: string,
    table: { id: string; name: string; projectId: string },
  ): Promise<Array<{ id: string; name: string; projectId: string }>> {
    const types = sql.join(
      DATA_TABLE_NODE_TYPES.map((type) => sql`${type}`),
      sql`, `,
    );
    return this.db
      .select({ id: workflows.id, name: workflows.name, projectId: workflows.projectId })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          eq(workflows.projectId, table.projectId),
          sql`exists (
            select 1 from jsonb_array_elements(${workflows.nodes}) n
            where n->>'type' in (${types})
              and case
                when n #>> '{parameters,dataTableId,mode}' = 'name'
                  then n #>> '{parameters,dataTableId,value}' = ${table.name}::text
                else coalesce(n #>> '{parameters,dataTableId,value}', n #>> '{parameters,dataTableId}') = ${table.id}::text
              end
          )`,
        ),
      )
      .orderBy(asc(workflows.name), asc(workflows.id));
  }
}
