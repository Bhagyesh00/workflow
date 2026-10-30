/** Postgres: run queries and insert / update / upsert / delete / select rows (node-postgres). */

import net from 'node:net';
import type {
  BaseContext,
  DataObject,
  ListSearchResult,
  LoadOptionsContext,
  NodeType,
} from '@workflow/workflow';
import pg from 'pg';
import { runSql, type SqlPool } from './runner';
import { postgresDialect, sqlProperties } from './sql';

interface PostgresCredentials extends DataObject {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: 'disable' | 'allow' | 'require';
  caCertificate?: string;
  maxConnections?: number;
}

/** Build a pool whose connections go only to addresses that passed the SSRF policy. */
export async function postgresPool(
  ctx: Pick<BaseContext, 'getCredentials' | 'helpers'>,
  options: { connectionTimeoutSeconds?: number } = {},
): Promise<pg.Pool> {
  const creds = await ctx.getCredentials<PostgresCredentials>('postgres');
  const host = String(creds.host ?? '').trim();
  if (!host) throw new Error('The Postgres credential has no host');
  const allowed = await ctx.helpers.resolveAllowedHost(host);
  let ssl: pg.PoolConfig['ssl'] = false;
  if (creds.ssl === 'allow') ssl = { rejectUnauthorized: false };
  if (creds.ssl === 'require')
    ssl = { rejectUnauthorized: true, ...(creds.caCertificate ? { ca: String(creds.caCertificate) } : {}) };
  const pool = new pg.Pool({
    // pg takes the TLS server name from `host`, so it stays the name the user entered
    host,
    port: Number(creds.port ?? 5432),
    // pg calls connect(port, host) on this socket itself: every connection goes only to the checked
    // addresses (pg resolving the name again could be sent elsewhere by a DNS rebind)
    stream: () => {
      const socket = new net.Socket();
      const connect = socket.connect.bind(socket);
      socket.connect = ((port: number, name: string) =>
        connect({
          port,
          host: name,
          lookup: allowed.lookup,
          autoSelectFamily: true,
        })) as typeof socket.connect;
      return socket;
    },
    database: creds.database ? String(creds.database) : undefined,
    user: creds.user ? String(creds.user) : undefined,
    password: creds.password ? String(creds.password) : undefined,
    ssl,
    max: Math.min(50, Math.max(1, Number(creds.maxConnections ?? 5))),
    connectionTimeoutMillis: Math.max(1, Number(options.connectionTimeoutSeconds ?? 30)) * 1000,
    idleTimeoutMillis: 10_000,
    application_name: 'workflow-platform',
  });
  // idle-client errors must not crash the process
  pool.on('error', () => undefined);
  return pool;
}

function wrapPool(pool: pg.Pool): SqlPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(q) {
          const result = await client.query({ text: q.text, values: q.values as unknown[] });
          // multiple statements without parameters return one result per statement
          const results = Array.isArray(result) ? (result as pg.QueryResult[]) : [result];
          return {
            rows: results.flatMap((r) => (r.rows ?? []) as DataObject[]),
            rowCount: results.reduce((n, r) => n + (r.rowCount ?? 0), 0),
            command: results[results.length - 1]?.command,
          };
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

async function withPool<T>(ctx: LoadOptionsContext, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = await postgresPool(ctx, { connectionTimeoutSeconds: 15 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function rlValue(value: unknown, fallback = ''): string {
  if (value && typeof value === 'object' && 'value' in (value as object))
    return String((value as { value: unknown }).value ?? fallback);
  return String(value ?? fallback);
}

export const PostgresNode: NodeType = {
  description: {
    name: 'app.postgres',
    displayName: 'Postgres',
    description: 'Query, insert, update, upsert and delete rows in PostgreSQL',
    icon: 'simple:postgresql',
    iconColor: '#336791',
    group: ['input', 'output'],
    version: 1,
    defaults: { name: 'Postgres' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Developer tools'],
    alias: ['sql', 'database', 'postgresql', 'pg', 'query', 'supabase'],
    subtitle: '={{ $parameter.operation }}',
    usableAsTool: true,
    credentials: [{ name: 'postgres', required: true }],
    properties: sqlProperties({ schema: true }),
  },

  async execute(ctx) {
    const pool = await postgresPool(ctx, {
      connectionTimeoutSeconds: Number(ctx.getNodeParameter('options.connectionTimeout', 0, 30)),
    });
    try {
      return await runSql(ctx, wrapPool(pool), postgresDialect, true);
    } finally {
      await pool.end();
    }
  },

  methods: {
    listSearch: {
      async searchSchemas(ctx, filter): Promise<ListSearchResult> {
        return withPool(ctx, async (pool) => {
          const { rows } = await pool.query(
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg_toast%' AND ($1 = '' OR schema_name ILIKE '%' || $1 || '%') ORDER BY schema_name",
            [filter ?? ''],
          );
          return {
            results: rows.map((r: DataObject) => ({
              name: String(r.schema_name),
              value: String(r.schema_name),
            })),
          };
        });
      },
      async searchTables(ctx, filter): Promise<ListSearchResult> {
        const schema = rlValue(ctx.getCurrentNodeParameter('schema'), 'public') || 'public';
        return withPool(ctx, async (pool) => {
          const { rows } = await pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND ($2 = '' OR table_name ILIKE '%' || $2 || '%') ORDER BY table_name",
            [schema, filter ?? ''],
          );
          return {
            results: rows.map((r: DataObject) => ({
              name: String(r.table_name),
              value: String(r.table_name),
            })),
          };
        });
      },
    },
    loadOptions: {
      async getColumns(ctx) {
        const schema = rlValue(ctx.getCurrentNodeParameter('schema'), 'public') || 'public';
        const table = rlValue(ctx.getCurrentNodeParameter('table'));
        if (!table) return [];
        return withPool(ctx, async (pool) => {
          const { rows } = await pool.query(
            'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
            [schema, table],
          );
          return rows.map((r: DataObject) => ({
            name: String(r.column_name),
            value: String(r.column_name),
            description: `Type: ${String(r.data_type)}`,
          }));
        });
      },
    },
  },
};
