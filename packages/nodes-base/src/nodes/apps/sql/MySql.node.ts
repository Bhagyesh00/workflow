/** MySQL: run queries and insert / update / upsert / delete / select rows (mysql2). */

import net from 'node:net';
import type {
  BaseContext,
  DataObject,
  ListSearchResult,
  LoadOptionsContext,
  NodeType,
} from '@workflow/workflow';
import mysql from 'mysql2/promise';
import { mysqlCredentialTest } from '../../../credential-tests/mysql';
import { openSshTunnel, type SshTunnel, sqlTlsOptions, sshTunnelEnabled } from '../../../utils/ssh-tunnel';
import { runSql, type SqlPool } from './runner';
import { mysqlDialect, sqlProperties } from './sql';

interface MySqlCredentials extends DataObject {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: 'disable' | 'allow' | 'require';
  caCertificate?: string;
  clientPrivateKey?: string;
  clientCertificate?: string;
  connectTimeout?: number;
}

/**
 * TLS options for mysql2. It reads only the chain settings and `verifyIdentity`: under `require` the
 * certificate must match the host name the user entered. With an IP address as the host mysql2 has no
 * name to check (it would check "localhost"), so there only the chain is verified.
 */
function mysqlSsl(creds: MySqlCredentials, host: string): mysql.SslOptions | undefined {
  const tls = sqlTlsOptions(creds, host);
  if (!tls) return undefined;
  return {
    rejectUnauthorized: tls.rejectUnauthorized,
    ...(tls.ca === undefined ? {} : { ca: tls.ca as string }),
    ...(tls.key === undefined ? {} : { key: tls.key as string }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert as string }),
    ...(creds.ssl === 'require' && !net.isIP(host) ? { verifyIdentity: true } : {}),
  };
}

/** Build a pool whose connections go only to addresses that passed the SSRF policy. */
export async function mysqlPool(
  ctx: Pick<BaseContext, 'getCredentials' | 'helpers'> & {
    signal?: AbortSignal;
  },
  options: { connectionTimeoutSeconds?: number } = {},
): Promise<mysql.Pool> {
  const creds = await ctx.getCredentials<MySqlCredentials>('mySql');
  const host = String(creds.host ?? '').trim();
  if (!host) throw new Error('The MySQL credential has no host');
  const port = Number(creds.port ?? 3306);
  // through an SSH tunnel the database host is resolved by the SSH server (the SSH host was checked
  // when the tunnel opened); otherwise every connection goes only to addresses that passed the policy
  const tunnel: SshTunnel | undefined = sshTunnelEnabled(creds)
    ? await openSshTunnel(ctx, creds, { host, port })
    : undefined;
  try {
    const allowed = tunnel ? undefined : await ctx.helpers.resolveAllowedHost(host);
    const pool = mysql.createPool({
      // mysql2 takes the TLS server name from `host` and ignores the server name and name check of the
      // TLS options, so `host` stays the name the user entered; the `stream` below does the connecting
      host,
      port: tunnel ? tunnel.port : port,
      // every connection goes only to the checked addresses: mysql2 resolving the name again could be
      // sent elsewhere by a DNS rebind
      stream: () => {
        const socket = net.connect({
          host: tunnel ? tunnel.host : host,
          port: tunnel ? tunnel.port : port,
          ...(allowed ? { lookup: allowed.lookup } : {}),
          autoSelectFamily: true,
        });
        socket.setNoDelay(true);
        socket.setKeepAlive(true);
        return socket;
      },
      database: creds.database ? String(creds.database) : undefined,
      user: creds.user ? String(creds.user) : undefined,
      password: creds.password ? String(creds.password) : undefined,
      ssl: mysqlSsl(creds, host),
      connectionLimit: 5,
      connectTimeout: options.connectionTimeoutSeconds
        ? options.connectionTimeoutSeconds * 1000
        : Number(creds.connectTimeout ?? 10_000),
      // values are always bound as parameters; never let objects expand into SQL fragments
      stringifyObjects: true,
      multipleStatements: false,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    if (tunnel) {
      // ending the pool closes the tunnel
      const end = pool.end.bind(pool);
      pool.end = (async () => {
        try {
          await end();
        } finally {
          await tunnel.close();
        }
      }) as typeof pool.end;
    }
    return pool;
  } catch (error) {
    await tunnel?.close();
    throw error;
  }
}

function wrapPool(pool: mysql.Pool): SqlPool {
  return {
    async connect() {
      const connection = await pool.getConnection();
      return {
        async query(q) {
          const [result] = await connection.query(q.text, q.values);
          if (Array.isArray(result)) {
            return { rows: result as DataObject[], rowCount: result.length };
          }
          const header = result as mysql.ResultSetHeader;
          return {
            rows: [],
            rowCount: header.affectedRows ?? 0,
            insertId: header.insertId || undefined,
          };
        },
        release: () => connection.release(),
      };
    },
    end: () => pool.end(),
  };
}

async function withPool<T>(ctx: LoadOptionsContext, fn: (pool: mysql.Pool) => Promise<T>): Promise<T> {
  const pool = await mysqlPool(ctx, { connectionTimeoutSeconds: 15 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function rlValue(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in (value as object))
    return String((value as { value: unknown }).value ?? '');
  return String(value ?? '');
}

export const MySqlNode: NodeType = {
  description: {
    name: 'app.mySql',
    displayName: 'MySQL',
    description: 'Query, insert, update, upsert and delete rows in MySQL or MariaDB',
    icon: 'simple:mysql',
    iconColor: '#4479a1',
    group: ['input', 'output'],
    version: 1,
    defaults: { name: 'MySQL' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Developer tools'],
    alias: ['sql', 'database', 'mariadb', 'query'],
    subtitle: '={{ $parameter.operation }}',
    usableAsTool: true,
    credentials: [{ name: 'mySql', required: true, testedBy: 'mysqlCredentialTest' }],
    properties: sqlProperties({ schema: false }),
  },

  async execute(ctx) {
    const timeout = Number(ctx.getNodeParameter('options.connectionTimeout', 0, 0));
    const pool = await mysqlPool(ctx, {
      connectionTimeoutSeconds: timeout || undefined,
    });
    try {
      return await runSql(ctx, wrapPool(pool), mysqlDialect, false);
    } finally {
      await pool.end();
    }
  },

  methods: {
    credentialTest: { mysqlCredentialTest },
    listSearch: {
      async searchTables(ctx, filter): Promise<ListSearchResult> {
        return withPool(ctx, async (pool) => {
          const [rows] = await pool.query(
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND (? = '' OR table_name LIKE CONCAT('%', ?, '%')) ORDER BY table_name",
            [filter ?? '', filter ?? ''],
          );
          return {
            results: (rows as DataObject[]).map((r) => ({
              name: String(r.name),
              value: String(r.name),
            })),
          };
        });
      },
    },
    loadOptions: {
      async getColumns(ctx) {
        const table = rlValue(ctx.getCurrentNodeParameter('table'));
        if (!table) return [];
        return withPool(ctx, async (pool) => {
          const [rows] = await pool.query(
            'SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
            [table],
          );
          return (rows as DataObject[]).map((r) => ({
            name: String(r.name),
            value: String(r.name),
            description: `Type: ${String(r.type)}`,
          }));
        });
      },
    },
  },
};
