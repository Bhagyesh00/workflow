/**
 * P6-12 (L10): the seam between the LDAP service and the wire (ldapts `Client` on the pinned lookup of
 * `resolveAllowedHost`), so tests swap in test/fakes/ldap-directory.ts. Filter values are escaped by the
 * service (RFC 4515) before they reach `search`. Stub from C0: the types are final; `openLdapDirectory`
 * throws until L10.
 */

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

/** opens a connection through the SSRF guard */
export async function openLdapDirectory(_options: LdapConnectionOptions): Promise<LdapDirectory> {
  throw new Error('not implemented (L10)');
}
