/**
 * P6-12 (L10): the seam between the LDAP service and the wire (ldapts `Client`), so tests swap in
 * test/fakes/ldap-directory.ts. Filter values are escaped by the service (RFC 4515) before they reach
 * `search`.
 *
 * SSRF: `openLdapDirectory` resolves the host once through `resolveAllowedHost` (every address is checked)
 * and hands ldapts its own `createConnection` and `createSecureConnection`, which connect through the
 * pinned `lookup`, so the socket never resolves the name again. TLS checks the certificate against the
 * host name (`servername`); `allowUnauthorizedCerts` is the workspace's own switch and is off by default.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { AllowedHost } from '@workflow/workflow';
import { Client, type Entry } from 'ldapts';

/** one entry of a search: its DN and the attributes asked for */
export interface LdapEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
}

export interface LdapSearchOptions {
  baseDn: string;
  filter: string;
  attributes: string[];
  /** 0 = no paging */
  pageSize: number;
  timeoutMs: number;
}

/** one connection to a directory; `close` always runs, also after a failed bind */
export interface LdapDirectory {
  bind(dn: string, password: string): Promise<void>;
  search(options: LdapSearchOptions): Promise<LdapEntry[]>;
  close(): Promise<void>;
}

/** where and how to connect (the workspace's `ldap` config, the bind password decrypted) */
export interface LdapConnectionOptions {
  host: string;
  port: number;
  security: 'none' | 'tls' | 'startTls';
  allowUnauthorizedCerts: boolean;
  timeoutMs: number;
}

/** `ctx.http.resolveAllowedHost`: throws for a host the SSRF policy refuses */
export type ResolveLdapHost = (host: string) => Promise<AllowedHost>;

const bareHost = (host: string): string => host.trim().replace(/^\[|\]$/g, '');

/** the text holds bytes no person types: a binary value (a GUID), not a name */
function looksBinary(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) return true;
  }
  return false;
}

/** binary values (a GUID) become hex; text stays text */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    return looksBinary(text) ? value.toString('hex') : text;
  }
  return String(value ?? '');
}

function attributesOf(entry: Entry): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (name === 'dn') continue;
    out[name] = Array.isArray(value) ? value.map(textOf) : textOf(value);
  }
  return out;
}

/** opens a connection through the SSRF guard */
export async function openLdapDirectory(
  options: LdapConnectionOptions,
  resolveHost: ResolveLdapHost,
): Promise<LdapDirectory> {
  const host = bareHost(options.host);
  const allowed = await resolveHost(host);
  const secureBase = {
    // the certificate is checked against the name the admin typed, never an address
    servername: net.isIP(host) ? undefined : host,
    rejectUnauthorized: !options.allowUnauthorizedCerts,
    minVersion: 'TLSv1.2' as const,
  };
  const createConnection = ((...args: unknown[]) => {
    const [port, name] = args;
    return net.connect({ port: Number(port), host: String(name), lookup: allowed.lookup });
  }) as unknown as typeof net.connect;
  const createSecureConnection = ((...args: unknown[]) => {
    const [first, second, third] = args;
    if (first && typeof first === 'object') {
      // the STARTTLS upgrade of the open socket
      return tls.connect({ ...(first as tls.ConnectionOptions), ...secureBase });
    }
    return tls.connect({
      ...(third && typeof third === 'object' ? (third as tls.ConnectionOptions) : {}),
      port: Number(first),
      host: String(second),
      lookup: allowed.lookup,
      ...secureBase,
    });
  }) as unknown as typeof tls.connect;

  const url = `${options.security === 'tls' ? 'ldaps' : 'ldap'}://${net.isIPv6(host) ? `[${host}]` : host}:${options.port}`;
  const client = new Client({
    url,
    timeout: options.timeoutMs,
    connectTimeout: options.timeoutMs,
    createConnection,
    createSecureConnection,
  });
  const close = async (): Promise<void> => {
    try {
      await client.unbind();
    } catch {
      // the connection is gone already
    }
  };
  if (options.security === 'startTls') {
    try {
      await client.startTLS({});
    } catch (error) {
      await close();
      throw error;
    }
  }
  return {
    async bind(dn, password) {
      await client.bind(dn, password);
    },
    async search(search) {
      const result = await client.search(search.baseDn, {
        scope: 'sub',
        filter: search.filter,
        attributes: search.attributes,
        paged: search.pageSize > 0 ? { pageSize: search.pageSize } : false,
        timeLimit: Math.max(0, Math.ceil(search.timeoutMs / 1000)),
      });
      return result.searchEntries.map((entry) => ({ dn: entry.dn, attributes: attributesOf(entry) }));
    },
    close,
  };
}
