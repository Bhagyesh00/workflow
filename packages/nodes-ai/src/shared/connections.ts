/**
 * Non-HTTP connections (PostgreSQL for memory / PGVector, Redis for memory). Every host passes the
 * SSRF policy through `ctx.helpers.assertHostAllowed` before connecting, and the connection is
 * pinned to an address that passed the policy itself, so a DNS rebind between the check and the
 * connect cannot redirect it. Consequence: a private database must be allow-listed by IP or CIDR
 * (or SSRF protection disabled); a hostname-only allow entry is not enough for these nodes.
 */
import dns from 'node:dns';
import net from 'node:net';
import type { BaseContext, DataObject } from '@workflow/workflow';
import { Redis } from 'ioredis';
import pg from 'pg';

export async function resolvePinnedHost(ctx: BaseContext, host: string): Promise<string> {
  const bare = host.trim().replace(/^\[|\]$/g, '');
  if (!bare) throw new Error('A host is required');
  await ctx.helpers.assertHostAllowed(bare);
  if (net.isIP(bare)) return bare;
  const addresses = await dns.promises.lookup(bare, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`Host "${bare}" did not resolve`);
  for (const a of addresses) await ctx.helpers.assertHostAllowed(a.address);
  return addresses[0].address;
}

export interface PostgresCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: 'disable' | 'allow' | 'require' | 'verify-full';
  allowUnauthorizedCerts: boolean;
}

/** Read a `postgres` credential, tolerating common field spellings. */
export function postgresCredentials(data: DataObject): PostgresCredentials {
  const sslValue = data.ssl;
  let ssl: PostgresCredentials['ssl'] = 'disable';
  if (sslValue === true || sslValue === 'require' || sslValue === 'prefer') ssl = 'require';
  else if (sslValue === 'allow') ssl = 'allow';
  else if (sslValue === 'verify' || sslValue === 'verify-full' || sslValue === 'verify-ca')
    ssl = 'verify-full';
  return {
    host: String(data.host ?? 'localhost'),
    port: Number(data.port ?? 5432),
    database: String(data.database ?? data.db ?? 'postgres'),
    user: String(data.user ?? data.username ?? 'postgres'),
    password: String(data.password ?? ''),
    ssl,
    allowUnauthorizedCerts: Boolean(data.allowUnauthorizedCerts ?? data.ignoreSslIssues ?? false),
  };
}

export async function connectPostgres(ctx: BaseContext, credentialType = 'postgres'): Promise<pg.Client> {
  const creds = postgresCredentials(await ctx.getCredentials(credentialType));
  const address = await resolvePinnedHost(ctx, creds.host);
  const ssl =
    creds.ssl === 'disable'
      ? false
      : {
          servername: net.isIP(creds.host) ? undefined : creds.host,
          rejectUnauthorized: creds.ssl === 'verify-full' && !creds.allowUnauthorizedCerts,
        };
  const client = new pg.Client({
    host: address,
    port: creds.port,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    ssl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    application_name: 'workflow-ai',
  });
  // connection-level errors after connect must not crash the process
  client.on('error', (error) => ctx.logger.warn('Postgres connection error', { error: error.message }));
  await client.connect();
  return client;
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
}

export function redisCredentials(data: DataObject): RedisCredentials {
  return {
    host: String(data.host ?? 'localhost'),
    port: Number(data.port ?? 6379),
    password: data.password ? String(data.password) : undefined,
    username: data.user || data.username ? String(data.user ?? data.username) : undefined,
    db: Number(data.database ?? data.db ?? 0),
    tls: Boolean(data.ssl ?? data.tls ?? false),
  };
}

export async function connectRedis(ctx: BaseContext, credentialType = 'redis'): Promise<Redis> {
  const creds = redisCredentials(await ctx.getCredentials(credentialType));
  const address = await resolvePinnedHost(ctx, creds.host);
  const client = new Redis({
    host: address,
    port: creds.port,
    password: creds.password,
    username: creds.username,
    db: creds.db,
    tls: creds.tls ? { servername: net.isIP(creds.host) ? undefined : creds.host } : undefined,
    lazyConnect: true,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  client.on('error', (error) => ctx.logger.warn('Redis connection error', { error: error.message }));
  await client.connect();
  return client;
}
