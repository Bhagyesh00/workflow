/**
 * Stub of the guarded socket helpers for protocols that are not HTTP (per-host SSRF check, then a
 * pinned lookup, plus TLS options); L12 (P4-21) builds it.
 */
import type { Socket } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import type { AllowedHost, DataObject, NodeHelpers } from '@workflow/workflow';

/** every node context and the credential test context have this */
export interface GuardedConnectContext {
  helpers: Pick<NodeHelpers, 'resolveAllowedHost'>;
}

export interface ConnectGuardedOptions {
  host: string;
  port: number;
  /** present: the socket is a TLS socket (with `servername` set to `host` when it is a name) */
  tls?: ConnectionOptions;
}

/** PEM fields and the verify switch, already mapped from a credential's own field names */
export interface BrokerTlsCredentials extends DataObject {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

/** check `host` against the SSRF policy and answer a lookup that uses only the checked addresses */
export async function guardedLookup(
  _ctx: GuardedConnectContext,
  _host: string,
): Promise<AllowedHost['lookup']> {
  throw new Error('not implemented (L12)');
}

/** a connected socket to the checked addresses of `host`; never resolves the name again */
export async function connectGuarded(
  _ctx: GuardedConnectContext,
  _options: ConnectGuardedOptions,
): Promise<Socket> {
  throw new Error('not implemented (L12)');
}

export function tlsOptions(_creds: BrokerTlsCredentials): ConnectionOptions {
  throw new Error('not implemented (L12)');
}
