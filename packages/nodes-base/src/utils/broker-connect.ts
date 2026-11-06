/**
 * Sockets for protocols that are not HTTP (brokers, mail, streams). The host goes through the SSRF guard
 * once per name, and the socket connects only to those checked addresses through the pinned `lookup`, so
 * a name that rebinds after the check, or a broker that advertises another host, cannot send it elsewhere.
 */
import net, { type Socket } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import type { AllowedHost, DataObject, NodeHelpers } from '@workflow/workflow';
import { formatPemBlock } from './pem';

const CONNECT_TIMEOUT_MS = 30_000;

/** every node context and the credential test context have this */
export interface GuardedConnectContext {
  helpers: Pick<NodeHelpers, 'resolveAllowedHost'>;
}

export interface ConnectGuardedOptions {
  host: string;
  port: number;
  /** present: the socket is a TLS socket (with `servername` set to `host` when it is a name) */
  tls?: ConnectionOptions;
  /** how long the connection and the TLS handshake may take (default 30 seconds) */
  timeoutMs?: number;
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
  ctx: GuardedConnectContext,
  host: string,
): Promise<AllowedHost['lookup']> {
  return (await ctx.helpers.resolveAllowedHost(host)).lookup;
}

/** a connected socket to the checked addresses of `host`; never resolves the name again */
export async function connectGuarded(
  ctx: GuardedConnectContext,
  options: ConnectGuardedOptions,
): Promise<Socket> {
  const { host, port, tls: tlsConfig, timeoutMs = CONNECT_TIMEOUT_MS } = options;
  const bare = host.trim().replace(/^\[|\]$/g, '');
  const lookup = await guardedLookup(ctx, bare);
  const target = { host: bare, port, lookup, autoSelectFamily: true };
  // TLS has no server name for an IP literal; the certificate is then checked against the address
  const socket: Socket = tlsConfig
    ? tls.connect({ ...tlsConfig, ...target, servername: net.isIP(bare) ? undefined : bare })
    : net.connect(target);
  const readyEvent = tlsConfig ? 'secureConnect' : 'connect';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out connecting to ${bare}:${port}`)), timeoutMs);
    const onReady = () => done();
    const onError = (error: Error) => done(error);
    function done(error?: Error) {
      clearTimeout(timer);
      socket.off(readyEvent, onReady);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve();
    }
    socket.once(readyEvent, onReady);
    socket.once('error', onError);
  });
  return socket;
}

/** connection options from credential fields; verification stays on unless the field turns it off */
export function tlsOptions(creds: BrokerTlsCredentials): ConnectionOptions {
  const options: ConnectionOptions = {};
  const pem = (value: string | undefined) => (value?.trim() ? formatPemBlock(value) : undefined);
  const ca = pem(creds.ca);
  const cert = pem(creds.cert);
  const key = pem(creds.key);
  if (ca) options.ca = ca;
  if (cert) options.cert = cert;
  if (key) options.key = key;
  if (creds.passphrase) options.passphrase = creds.passphrase;
  if (typeof creds.rejectUnauthorized === 'boolean') options.rejectUnauthorized = creds.rejectUnauthorized;
  return options;
}
