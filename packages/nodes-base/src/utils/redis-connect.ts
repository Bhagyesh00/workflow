/**
 * The guarded Redis client. The host goes through the SSRF check once and the client connects to the
 * first checked address (ioredis takes no `lookup`), with the TLS server name set to the host name.
 */
import net from 'node:net';
import type { DataObject, NodeCredentialTestResult, NodeHelpers } from '@workflow/workflow';
import { Redis, type RedisOptions } from 'ioredis';

/** the fields of the `redis` credential (apps.credentials.ts) */
export interface RedisCredentials extends DataObject {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: number;
  ssl?: boolean;
  disableTlsVerification?: boolean;
}

const CONNECT_TIMEOUT_MS = 10_000;

export async function openRedis(
  ctx: { helpers: Pick<NodeHelpers, 'resolveAllowedHost'> },
  creds: RedisCredentials,
  opts: RedisOptions = {},
): Promise<Redis> {
  const host = String(creds.host || 'localhost').trim();
  const allowed = await ctx.helpers.resolveAllowedHost(host);
  const client = new Redis({
    host: allowed.addresses[0].address,
    port: Number(creds.port || 6379),
    username: creds.user ? String(creds.user) : undefined,
    password: creds.password ? String(creds.password) : undefined,
    db: Number(creds.database || 0),
    tls: creds.ssl
      ? {
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: creds.disableTlsVerification !== true,
        }
      : undefined,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    ...opts,
  });
  // without a listener an error on the connection would end the process; callers watch 'end'
  client.on('error', () => undefined);
  let reached = false;
  client.once('connect', () => {
    reached = true;
  });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    // the caller can tell a server that answered (and refused the login) from one that was never reached
    throw Object.assign(error as Error, { reachedServer: reached });
  }
  return client;
}

/** the Test button of the Redis credential: connect, authenticate, PING; the answer never carries the server's text */
export async function redisCredentialTest(
  ctx: { helpers: Pick<NodeHelpers, 'resolveAllowedHost'> },
  credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  let client: Redis | undefined;
  try {
    client = await openRedis(ctx, credential.data as RedisCredentials, {
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    await client.ping();
    return { status: 'OK', message: 'Connection tested successfully' };
  } catch (error) {
    const text = String((error as Error)?.message ?? '');
    if ((error as { reachedServer?: boolean }).reachedServer || /WRONGPASS|NOAUTH|AUTH/i.test(text))
      return { status: 'Error', message: 'Redis refused the user or password' };
    return { status: 'Error', message: 'Could not connect to Redis' };
  } finally {
    client?.disconnect();
  }
}
