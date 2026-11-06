/** Stub of the guarded Redis client (pinned to the first checked address); L15 (P4-10) builds it. */
import type { DataObject, NodeHelpers } from '@workflow/workflow';
import type { Redis, RedisOptions } from 'ioredis';

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

export async function openRedis(
  _ctx: { helpers: Pick<NodeHelpers, 'resolveAllowedHost'> },
  _creds: RedisCredentials,
  _opts: RedisOptions = {},
): Promise<Redis> {
  throw new Error('not implemented (L15)');
}
