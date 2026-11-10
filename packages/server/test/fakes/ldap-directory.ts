/**
 * P6-12 (L10): an in-memory LDAP directory for logic tests. `createFakeLdap()` gives the `openDirectory`
 * seam of `LdapService` (assign it to `ctx.ldap.openDirectory`), a list of entries with `userPassword`, the
 * admin account, the connection options each open got and every search it answered. Filters are evaluated
 * for real: `(a=b)`, `(a=*)`, `(&...)`, `(|...)`, `(!...)`, with RFC 4515 escapes (`\2a`) decoded, so an
 * injection test sees the filter the service built and what it matched.
 */
import type {
  LdapConnectionOptions,
  LdapDirectory,
  LdapEntry,
  LdapSearchOptions,
} from '../../src/services/sso/ldap-directory';

export interface FakeLdapEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
  /** the bind password of the entry; none = the entry cannot bind */
  password?: string;
}

export class FakeInvalidCredentials extends Error {
  constructor() {
    super('Invalid Credentials');
    this.name = 'InvalidCredentialsError';
  }
}

/** a filter, parsed */
type Node =
  | { op: 'and' | 'or'; items: Node[] }
  | { op: 'not'; item: Node }
  | { op: 'eq'; name: string; value: string }
  | { op: 'present'; name: string };

function unescapeValue(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function parseFilter(text: string): Node {
  let i = 0;
  const parseItem = (): Node => {
    if (text[i] !== '(') throw new Error(`Bad filter at ${i}: ${text}`);
    i++;
    const kind = text[i];
    let node: Node;
    if (kind === '&' || kind === '|') {
      i++;
      const items: Node[] = [];
      while (text[i] === '(') items.push(parseItem());
      node = { op: kind === '&' ? 'and' : 'or', items };
    } else if (kind === '!') {
      i++;
      node = { op: 'not', item: parseItem() };
    } else {
      let end = i;
      while (end < text.length && text[end] !== ')') end += text[end] === '\\' ? 2 : 1;
      const body = text.slice(i, end);
      const eq = body.indexOf('=');
      if (eq < 1) throw new Error(`Bad filter item: ${body}`);
      const name = body.slice(0, eq);
      const raw = body.slice(eq + 1);
      node = raw === '*' ? { op: 'present', name } : { op: 'eq', name, value: unescapeValue(raw) };
      i = end;
    }
    if (text[i] !== ')') throw new Error(`Bad filter, missing ) at ${i}: ${text}`);
    i++;
    return node;
  };
  const node = parseItem();
  if (i !== text.length) throw new Error(`Bad filter, trailing text: ${text}`);
  return node;
}

function valuesOf(entry: FakeLdapEntry, name: string): string[] {
  const key = Object.keys(entry.attributes).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (key === undefined) return [];
  const value = entry.attributes[key];
  return Array.isArray(value) ? value : [value];
}

function matches(node: Node, entry: FakeLdapEntry): boolean {
  switch (node.op) {
    case 'and':
      return node.items.every((item) => matches(item, entry));
    case 'or':
      return node.items.some((item) => matches(item, entry));
    case 'not':
      return !matches(node.item, entry);
    case 'present':
      return node.name.toLowerCase() === 'objectclass' || valuesOf(entry, node.name).length > 0;
    case 'eq':
      return valuesOf(entry, node.name).some((value) => value.toLowerCase() === node.value.toLowerCase());
  }
}

export interface FakeLdapOptions {
  baseDn: string;
  adminDn?: string;
  adminPassword?: string;
  entries?: FakeLdapEntry[];
}

export interface FakeLdap {
  baseDn: string;
  entries: FakeLdapEntry[];
  /** the connection options of every open, newest last */
  opened: LdapConnectionOptions[];
  /** every search answered: the options as the service sent them */
  searches: LdapSearchOptions[];
  /** every bind: the DN only (never the password) and whether it worked */
  binds: Array<{ dn: string; ok: boolean }>;
  /** makes the next opens fail with this error (null = back to working) */
  failOpen: Error | null;
  /** an artificial delay of every search, ms */
  searchDelayMs: number;
  /** the seam: assign to `ctx.ldap.openDirectory` */
  open: (options: LdapConnectionOptions) => Promise<LdapDirectory>;
  /** adds a person: uid, mail, givenName, sn and a password */
  addPerson(person: {
    uid: string;
    mail?: string;
    givenName?: string;
    sn?: string;
    password?: string;
    extra?: Record<string, string | string[]>;
  }): FakeLdapEntry;
  remove(uid: string): void;
}

export function createFakeLdap(options: FakeLdapOptions): FakeLdap {
  const fake: FakeLdap = {
    baseDn: options.baseDn,
    entries: [...(options.entries ?? [])],
    opened: [],
    searches: [],
    binds: [],
    failOpen: null,
    searchDelayMs: 0,
    async open(connection) {
      if (fake.failOpen) throw fake.failOpen;
      fake.opened.push({ ...connection });
      let bound: string | null = null;
      return {
        async bind(dn, password) {
          const admin = options.adminDn !== undefined && dn === options.adminDn;
          const entry = fake.entries.find((candidate) => candidate.dn === dn);
          const ok =
            password.length > 0 &&
            ((admin && password === options.adminPassword) ||
              (!admin && entry?.password !== undefined && entry.password === password));
          fake.binds.push({ dn, ok });
          if (!ok) throw new FakeInvalidCredentials();
          bound = dn;
        },
        async search(search): Promise<LdapEntry[]> {
          fake.searches.push({ ...search });
          if (fake.searchDelayMs) await new Promise((resolve) => setTimeout(resolve, fake.searchDelayMs));
          if (options.adminDn !== undefined && bound === null) {
            throw new Error('Operations error: a bind is required');
          }
          const node = parseFilter(search.filter);
          return fake.entries
            .filter((entry) => entry.dn.toLowerCase().endsWith(search.baseDn.toLowerCase()))
            .filter((entry) => matches(node, entry))
            .map((entry) => {
              const attributes: Record<string, string | string[]> = {};
              for (const name of search.attributes) {
                const key = Object.keys(entry.attributes).find((c) => c.toLowerCase() === name.toLowerCase());
                if (key !== undefined) attributes[key] = entry.attributes[key];
              }
              return { dn: entry.dn, attributes };
            });
        },
        async close() {
          bound = null;
        },
      };
    },
    addPerson(person) {
      const entry: FakeLdapEntry = {
        dn: `uid=${person.uid},ou=people,${options.baseDn}`,
        attributes: {
          uid: person.uid,
          ...(person.mail ? { mail: person.mail } : {}),
          ...(person.givenName ? { givenName: person.givenName } : {}),
          ...(person.sn ? { sn: person.sn } : {}),
          objectClass: ['inetOrgPerson'],
          entryUUID: `uuid-${person.uid}`,
          ...person.extra,
        },
        ...(person.password ? { password: person.password } : {}),
      };
      fake.entries.push(entry);
      return entry;
    },
    remove(uid) {
      fake.entries = fake.entries.filter((entry) => valuesOf(entry, 'uid')[0] !== uid);
    },
  };
  return fake;
}
