import path from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { packageDir } from '../config';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** a database handle or an open transaction */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 20 });
  // idle client errors (e.g. server restarts) must not crash the process
  pool.on('error', () => {});
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}

export const migrationsFolder = path.join(packageDir, 'migrations');

/** advisory lock id shared by every process applying migrations */
const MIGRATION_LOCK = 727_001;

/** Apply pending migrations; safe to call concurrently from several processes. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}
