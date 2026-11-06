/**
 * Non-HTTP connections (PostgreSQL for memory / PGVector, Redis for memory). Every host is resolved
 * once and checked against the SSRF policy through `ctx.helpers.resolveAllowedHost`, and the
 * connection goes only to addresses that passed, so a DNS rebind between the check and the connect
 * cannot redirect it.
 */
import net from 'node:net';
import type { BaseContext, DataObject } from '@workflow/workflow';
import { Redis } from 'ioredis';
import pg from 'pg';
import { acquireShared, type Shared, sharedKey } from './shared-resource';

export interface PostgresCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: 'disable' | 'allow' | 'require';
  /** PEM of the CA that signed the server certificate (private CAs); used when ssl is 'require' */
  caCertificate: string;
}

/** Read a `postgres` credential (field names as defined by the nodes-base credential type). */
export function postgresCredentials(data: DataObject): PostgresCredentials {
  const ssl: PostgresCredentials['ssl'] =
    data.ssl === 'allow' || data.ssl === 'require' ? data.ssl : 'disable';
  return {
    host: String(data.host ?? 'localhost'),
    port: Number(data.port ?? 5432),
    database: String(data.database ?? 'postgres'),
    user: String(data.user ?? 'postgres'),
    password: String(data.password ?? ''),
    ssl,
    caCertificate: String(data.caCertificate ?? ''),
  };
}

/**
 * TLS options for the SSL setting, the same as the Postgres node: 'allow' encrypts without checking
 * the certificate, 'require' encrypts and verifies it (against the CA certificate when one is set).
 */
export function postgresTlsOptions(creds: PostgresCredentials): pg.ClientConfig['ssl'] {
  if (creds.ssl === 'allow') return { rejectUnauthorized: false };
  if (creds.ssl === 'require') {
    return { rejectUnauthorized: true, ...(creds.caCertificate ? { ca: creds.caCertificate } : {}) };
  }
  return false;
}

async function openPostgres(ctx: BaseContext, creds: PostgresCredentials): Promise<pg.Client> {
  const host = creds.host.trim();
  const allowed = await ctx.helpers.resolveAllowedHost(host);
  const client = new pg.Client({
    // pg takes the TLS server name from `host`, so it stays the name the user entered
    host,
    port: creds.port,
    // pg calls connect(port, host) on this socket itself: route it through the checked addresses only
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
    database: creds.database,
    user: creds.user,
    password: creds.password,
    ssl: postgresTlsOptions(creds),
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    application_name: 'workflow-ai',
  });
  // connection-level errors after connect must not crash the process
  client.on('error', (error) => ctx.logger.warn('Postgres connection error', { error: error.message }));
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

/**
 * A Postgres client for this node in this execution, shared by all items. Release it in the
 * node's close function; the connection ends when the last user releases it.
 */
export async function sharedPostgres(
  ctx: BaseContext,
  itemIndex: number,
  credentialType = 'postgres',
): Promise<Shared<pg.Client>> {
  const creds = postgresCredentials(await ctx.getCredentials(credentialType, itemIndex));
  return acquireShared(
    sharedKey(ctx, 'postgres', creds),
    () => openPostgres(ctx, creds),
    (client) => client.end(),
  );
}

/** `schema.table` or `table`, letters/digits/underscore only; returned quoted. */
export function quoteTableName(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || !parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(p))) {
    throw new Error(
      `Invalid table name "${name}": use letters, digits and underscores (optionally schema.table)`,
    );
  }
  return parts.map((p) => `"${p}"`).join('.');
}

export interface RedisCredentials {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db: number;
  tls: boolean;
  /** accept a certificate that cannot be verified (the credential's Disable TLS Verification, with SSL on) */
  tlsInsecure?: boolean;
}

/** Read a `redis` credential (field names as defined by the nodes-base credential type). */
export function redisCredentials(data: DataObject): RedisCredentials {
  return {
    host: String(data.host ?? 'localhost'),
    port: Number(data.port ?? 6379),
    password: data.password ? String(data.password) : undefined,
    username: data.user ? String(data.user) : undefined,
    db: Number(data.database ?? 0),
    tls: Boolean(data.ssl ?? false),
    tlsInsecure: data.ssl === true && data.disableTlsVerification === true ? true : undefined,
  };
}

async function openRedis(ctx: BaseContext, creds: RedisCredentials): Promise<Redis> {
  const allowed = await ctx.helpers.resolveAllowedHost(creds.host);
  const client = new Redis({
    // ioredis takes no `lookup`, so it is pinned to the first checked address
    host: allowed.addresses[0].address,
    port: creds.port,
    password: creds.password,
    username: creds.username,
    db: creds.db,
    tls: creds.tls
      ? {
          servername: net.isIP(creds.host) ? undefined : creds.host,
          ...(creds.tlsInsecure ? { rejectUnauthorized: false } : {}),
        }
      : undefined,
    lazyConnect: true,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  client.on('error', (error) => ctx.logger.warn('Redis connection error', { error: error.message }));
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    throw error;
  }
  return client;
}

/** A Redis client for this node in this execution, shared by all items (see `sharedPostgres`). */
export async function sharedRedis(
  ctx: BaseContext,
  itemIndex: number,
  credentialType = 'redis',
): Promise<Shared<Redis>> {
  const creds = redisCredentials(await ctx.getCredentials(credentialType, itemIndex));
  return acquireShared(
    sharedKey(ctx, 'redis', creds),
    () => openRedis(ctx, creds),
    async (client) => {
      await client.quit().catch(() => client.disconnect());
    },
  );
}
