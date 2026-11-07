/**
 * An in-memory DataTableAccess with just enough of the server's rules for the nodes' calls (Data Table,
 * Evaluation Trigger and Evaluation). `calls` records the calls that tests count.
 */
import {
  DATA_TABLE_ERRORS,
  type DataTableAccess,
  type DataTableCellValue,
  type DataTableColumn,
  type DataTableColumnInput,
  type DataTableFilter,
  type DataTableInfo,
  type DataTableRow,
  type DataTableRowInput,
  type DataTableRowResult,
  type DataTableRowsQuery,
} from '@workflow/workflow';

export class NotFound extends Error {
  details = { description: DATA_TABLE_ERRORS.tableIdNotFoundDescription };
}

/** just enough of the server's rules for the node's calls */
export class FakeTables implements DataTableAccess {
  tables = new Map<string, { info: DataTableInfo; rows: DataTableRow[]; next: number }>();
  calls: string[] = [];
  private seq = 0;

  private coerce(t: { info: DataTableInfo }, data: DataTableRowInput): Record<string, DataTableCellValue> {
    const out: Record<string, DataTableCellValue> = {};
    for (const [k, v] of Object.entries(data)) {
      const type = t.info.columns.find((c) => c.name === k)?.type;
      out[k] = v instanceof Date ? v.toISOString() : type === 'number' && v !== null ? Number(v) : v;
    }
    return out;
  }

  private need(id: string) {
    const t = this.tables.get(id);
    if (!t) throw new NotFound(DATA_TABLE_ERRORS.tableIdNotFound(id));
    return t;
  }
  add(name: string, columns: Array<{ name: string; type: DataTableColumn['type'] }>): DataTableInfo {
    const id = `t${++this.seq}`;
    const at = '2026-01-01T00:00:00.000Z';
    const info: DataTableInfo = {
      id,
      name,
      columns: columns.map((c, n) => ({ ...c, id: `${id}c${n}`, position: n, createdAt: at, updatedAt: at })),
      createdAt: at,
      updatedAt: at,
    };
    this.tables.set(id, { info, rows: [], next: 1 });
    return info;
  }
  async listTables(query: { name?: string; take?: number; skip?: number } = {}) {
    this.calls.push('listTables');
    const all = [...this.tables.values()]
      .map((t) => t.info)
      .filter((t) => !query.name || t.name.toLowerCase().includes(query.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { count: all.length, data: all.slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? 250)) };
  }
  async getTable(ref: { id: string } | { name: string }) {
    this.calls.push('getTable');
    if ('id' in ref) return this.tables.get(ref.id)?.info ?? null;
    return [...this.tables.values()].find((t) => t.info.name === ref.name)?.info ?? null;
  }
  async createTable(input: {
    name: string;
    columns: Array<{ name: string; type: DataTableColumn['type'] }>;
    reuseExisting?: boolean;
  }) {
    const existing = [...this.tables.values()].find((t) => t.info.name === input.name);
    if (existing) {
      if (input.reuseExisting) return existing.info;
      throw new Error(DATA_TABLE_ERRORS.tableNameExists(input.name));
    }
    return this.add(input.name, input.columns);
  }
  async renameTable(id: string, name: string) {
    const t = this.need(id);
    t.info = { ...t.info, name };
    return t.info;
  }
  async deleteTable(id: string) {
    this.need(id);
    this.tables.delete(id);
  }
  async clearTable(id: string) {
    const t = this.need(id);
    const deletedCount = t.rows.length;
    t.rows = [];
    return { deletedCount };
  }
  async listColumns(id: string) {
    return this.need(id).info.columns;
  }
  /** one column at the end; existing rows read null in it; a taken name fails as on the server */
  async addColumn(id: string, column: DataTableColumnInput): Promise<DataTableColumn> {
    this.calls.push(`addColumn:${column.name}`);
    const t = this.need(id);
    if (t.info.columns.some((c) => c.name === column.name)) {
      throw new Error(DATA_TABLE_ERRORS.columnNameExists(column.name, t.info.name));
    }
    const at = '2026-01-03T00:00:00.000Z';
    const made: DataTableColumn = {
      id: `${id}c${t.info.columns.length}`,
      name: column.name,
      type: column.type,
      position: t.info.columns.length,
      createdAt: at,
      updatedAt: at,
    };
    t.info = { ...t.info, columns: [...t.info.columns, made] };
    for (const row of t.rows) (row as Record<string, DataTableCellValue>)[column.name] = null;
    return made;
  }
  async insertRows(id: string, rows: DataTableRowInput[], returnType: 'all' | 'id' | 'count'): Promise<any> {
    this.calls.push(`insertRows:${rows.length}`);
    const t = this.need(id);
    const made = rows.map((r) => {
      const row: DataTableRow = {
        id: t.next++,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      };
      for (const c of t.info.columns) {
        (row as Record<string, DataTableCellValue>)[c.name] = this.coerce(t, r)[c.name] ?? null;
      }
      return row;
    });
    t.rows.push(...made);
    if (returnType === 'count') return { success: true, insertedRows: made.length };
    return returnType === 'id' ? made.map((m) => ({ id: m.id })) : made;
  }
  private matches(row: DataTableRow, filter: DataTableFilter | undefined): boolean {
    if (!filter?.filters.length) return true;
    const test = (f: DataTableFilter['filters'][number]) => {
      const v = (row as Record<string, unknown>)[f.columnName] ?? null;
      const want = f.value instanceof Date ? f.value.toISOString() : f.value;
      switch (f.condition) {
        case 'eq':
          return v === want;
        case 'neq':
          return v !== want;
        case 'like':
        case 'ilike':
          return String(v).toLowerCase().includes(String(want).replace(/%/g, '').toLowerCase());
        case 'gt':
          return (v as number) > (want as number);
        case 'gte':
          return (v as number) >= (want as number);
        case 'lt':
          return (v as number) < (want as number);
        case 'lte':
          return (v as number) <= (want as number);
        case 'isEmpty':
          return v === null || v === '';
        default:
          return v !== null && v !== '';
      }
    };
    return filter.type === 'and' ? filter.filters.every(test) : filter.filters.some(test);
  }
  async getRows(id: string, query: DataTableRowsQuery = {}) {
    this.calls.push(`getRows:${query.take}:${query.skip}`);
    const t = this.need(id);
    let rows = t.rows.filter((r) => this.matches(r, query.filter));
    if (query.sortBy) {
      const { column, direction } = query.sortBy;
      rows = [...rows].sort((a, b) => {
        const x = (a as Record<string, any>)[column];
        const y = (b as Record<string, any>)[column];
        return (x > y ? 1 : x < y ? -1 : 0) * (direction === 'asc' ? 1 : -1);
      });
    }
    const take = Math.min(query.take ?? 250, 250);
    return { count: rows.length, data: rows.slice(query.skip ?? 0, (query.skip ?? 0) + take) };
  }
  async updateRows(
    id: string,
    change: { filter: DataTableFilter; data: DataTableRowInput },
    o: { dryRun?: boolean } = {},
  ) {
    const t = this.need(id);
    const hit = t.rows.filter((r) => this.matches(r, change.filter));
    const patch = this.coerce(t, change.data);
    if (o.dryRun) {
      return hit.flatMap((r) => [
        { ...r, dryRunState: 'before' as const },
        { ...r, ...patch, dryRunState: 'after' as const },
      ]) as DataTableRowResult[];
    }
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r })) as DataTableRowResult[];
  }
  async upsertRow(
    id: string,
    change: { filter: DataTableFilter; data: DataTableRowInput },
    o: { dryRun?: boolean } = {},
  ) {
    const t = this.need(id);
    if (t.rows.some((r) => this.matches(r, change.filter))) return this.updateRows(id, change, o);
    if (o.dryRun)
      return [
        { id: 0, createdAt: '', updatedAt: '', ...change.data, dryRunState: 'after' },
      ] as unknown as DataTableRowResult[];
    return (await this.insertRows(id, [change.data], 'all')) as DataTableRowResult[];
  }
  async deleteRows(id: string, filter: DataTableFilter, o: { dryRun?: boolean } = {}) {
    const t = this.need(id);
    const hit = t.rows.filter((r) => this.matches(r, filter));
    if (!o.dryRun) t.rows = t.rows.filter((r) => !hit.includes(r));
    return hit.map((r) => ({
      ...r,
      ...(o.dryRun ? { dryRunState: 'before' as const } : {}),
    })) as DataTableRowResult[];
  }
  async rowsExist(id: string, filter: DataTableFilter) {
    return this.need(id).rows.some((r) => this.matches(r, filter));
  }
}
