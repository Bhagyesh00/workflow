/**
 * MongoDB client behind the SSRF guard. Every socket of the driver (seed, discovered member,
 * monitor, pool) goes through an own loopback SOCKS5 listener that checks each destination with
 * `resolveAllowedHost` and connects only to the checked addresses. Stub: L12 fills it.
 */
import type { CredentialTestContext, DataObject, NodeCredentialTestResult } from '@workflow/workflow';
import type { MongoClient, MongoClientOptions } from 'mongodb';
import type { ConnectionContext, Shared } from './shared-resource';

export interface MongoHandle {
  client: MongoClient;
  /** the credential's database, when it names one; the node's own parameter may override it */
  databaseName: string | undefined;
}

/** A guarded MongoDB client for this node in this execution, shared by all items (see `sharedPostgres`). */
export async function sharedMongo(
  _ctx: ConnectionContext,
  _itemIndex: number,
  _credentialType?: string,
): Promise<Shared<MongoHandle>> {
  throw new Error('not implemented (L12)');
}

/** Connection string (allow-listed options only) and driver options from a `mongoDb` credential. */
export function buildMongoOptions(_credentials: DataObject): { url: string; options: MongoClientOptions } {
  throw new Error('not implemented (L12)');
}

/** The loopback SOCKS5 guard one client connects through; closes with the client. */
export async function startMongoGuard(
  _ctx: Pick<CredentialTestContext, 'helpers' | 'logger'>,
): Promise<{ port: number; username: string; password: string; close(): Promise<void> }> {
  throw new Error('not implemented (L12)');
}

/** The error with the password and the whole connection string removed from its text. */
export function sanitizeMongoError(_error: unknown, _credentials: DataObject): Error {
  throw new Error('not implemented (L12)');
}

/** Credential test of `mongoDb` (named by `testedBy` on the MongoDB nodes). */
export async function mongoDbConnectionTest(
  _ctx: CredentialTestContext,
  _credential: { type: string; data: DataObject },
): Promise<NodeCredentialTestResult> {
  throw new Error('not implemented (L12)');
}
