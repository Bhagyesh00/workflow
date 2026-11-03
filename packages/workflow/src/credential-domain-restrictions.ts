/**
 * "Allowed HTTP Request Domains" for credentials: which hosts a credential may be sent to.
 *
 * Two fields are added to credential types that send requests (see CredentialTypes.getResolved):
 * a mode (`all`, `domains`, `none`) and a comma-separated list. The rules are n8n's:
 * - a host matches an entry exactly, compared case-insensitively and without a trailing dot;
 * - `*.example.com` matches subdomains only, never `example.com` itself;
 * - ports, paths and the scheme of the request URL are ignored;
 * - mode `domains` with an empty list is an error, never "allow everything";
 * - mode `none` refuses only requests to a URL the user typed (HTTP Request, GraphQL, the HTTP Request
 *   Tool, the MCP Client Tool); an app node that talks to its own endpoint is not blocked by it.
 *
 * Errors name the host and the list, never the full URL (a query string can carry a secret).
 * Pure functions, no node: imports: this file is bundled by the editor as well.
 */
import { WorkflowError } from './errors';
import type { DataObject, NodeProperty } from './interfaces';

/** the credential fields added to credential types that send requests */
export const ALLOWED_DOMAINS_PROPERTIES: NodeProperty[] = [
  {
    displayName: 'Allowed HTTP Request Domains',
    name: 'allowedHttpRequestDomains',
    type: 'options',
    default: 'all',
    description: 'Control which domains this credential may be sent to',
    noDataExpression: true,
    options: [
      { name: 'All', value: 'all', description: 'Allow use of this credential for every domain' },
      {
        name: 'Specific Domains',
        value: 'domains',
        description: 'Allow use of this credential only for the domains listed below',
      },
      {
        name: 'None',
        value: 'none',
        description: 'Block use of this credential in the HTTP Request and GraphQL nodes',
      },
    ],
  },
  {
    displayName: 'Allowed Domains',
    name: 'allowedDomains',
    type: 'string',
    default: '',
    placeholder: 'example.com, *.subdomain.com',
    description: 'Comma-separated list of allowed domains (supports wildcards with *)',
    noDataExpression: true,
    displayOptions: { show: { allowedHttpRequestDomains: ['domains'] } },
  },
];

/** thrown before a request when its URL (or a redirect hop) is outside the credential's list */
export class CredentialDomainError extends WorkflowError {
  constructor(
    message: string,
    /** the host that was refused */
    readonly host?: string,
  ) {
    super(message, { code: 'CREDENTIAL_DOMAIN' });
  }
}

/** host of a URL (or a bare host), lower-cased, without a trailing dot or the brackets of an IPv6 literal */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

/** a plain host name or IPv4/IPv6 literal; anything with a scheme, port, path or user info is not */
const PLAIN_HOST = /^[^\s/\\?#@:*]+$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/i;

/** one list entry as a host (punycode for non-ASCII), or undefined when it cannot name a host */
function normalizeEntryHost(entry: string): string | undefined {
  const raw = normalizeHost(entry);
  if (IPV6_LITERAL.test(entry.trim())) return raw;
  if (!PLAIN_HOST.test(raw)) return undefined;
  try {
    return normalizeHost(new URL(`http://${raw}`).hostname);
  } catch {
    return undefined;
  }
}

/** true when `host` matches an entry of `list` (`*.x.com` = subdomains of x.com only) */
export function isDomainAllowed(host: string, list: string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const entry of list) {
    const e = entry.trim().toLowerCase();
    if (e.startsWith('*.')) {
      const suffix = normalizeEntryHost(e.slice(2));
      // `*.x.com` needs a non-empty label in front of `.x.com`
      if (suffix && h.length > suffix.length + 1 && h.endsWith(`.${suffix}`)) return true;
    } else {
      const exact = normalizeEntryHost(e);
      if (exact !== undefined && exact === h) return true;
    }
  }
  return false;
}

/** the entries of a comma-separated list: trimmed, lower-cased, empty entries dropped */
function parseDomainList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The host list a credential allows, or undefined when it is unrestricted. `userUrl`: the request URL
 * was typed by the user, so the `none` mode applies. Throws CredentialDomainError for `none` on such a
 * surface, for `domains` with an empty list, and for an unknown mode (fail closed).
 */
export function getCredentialAllowedDomains(
  data: DataObject,
  options: { userUrl: boolean },
): string[] | undefined {
  const mode = data?.allowedHttpRequestDomains;
  if (mode === undefined || mode === null || mode === '' || mode === 'all') return undefined;
  if (mode === 'none') {
    if (!options.userUrl) return undefined;
    throw new CredentialDomainError(
      'This credential is configured to prevent use within an HTTP Request or GraphQL node',
    );
  }
  if (mode === 'domains') {
    const list = parseDomainList(data.allowedDomains);
    if (list.length === 0) {
      throw new CredentialDomainError(
        'No allowed domains specified. Configure allowed domains or change the restriction setting of this credential',
      );
    }
    return list;
  }
  throw new CredentialDomainError(
    'The credential has an unknown "Allowed HTTP Request Domains" setting. Open the credential and choose All, Specific Domains or None',
  );
}

/** throws CredentialDomainError when `url` is outside `list`; undefined list = unrestricted */
export function assertCredentialUrlAllowed(url: string, list: string[] | undefined): void {
  if (list === undefined) return;
  let host: string;
  try {
    host = normalizeHost(new URL(url).hostname);
  } catch {
    // the URL is not echoed: it may carry a secret in its query string
    throw new CredentialDomainError(
      'Domain not allowed: the request URL is not valid, so this credential cannot be sent to it',
    );
  }
  if (!isDomainAllowed(host, list)) {
    throw new CredentialDomainError(
      `Domain not allowed: This credential is restricted from accessing ${host}. Only the following domains are allowed: ${list.join(', ')}`,
      host,
    );
  }
}
