/** Who may open a form: IP allowlist, Ignore Bots and Basic auth with the page's `x-auth-token`. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { DataObject, WebhookContext } from '@workflow/workflow';
import { isBotUserAgent } from '../../../utils/bots';

/** n8n's realm; the browser asks for a login on it */
export const WWW_AUTHENTICATE = 'Basic realm="Enter credentials"';

/** as long as the sign-in token of the same forms */
const BASIC_TOKEN_TTL_SECONDS = 60 * 60;
const BASIC_TOKEN_KIND = 'form-basic';

export function headerValue(ctx: WebhookContext, name: string): string | undefined {
  const value = ctx.getHeaderData()[name];
  return Array.isArray(value) ? value[0] : value;
}

/** a mapped address (`::ffff:1.2.3.4`) counts as its IPv4 form, whichever way the server reports it */
const plainAddress = (ip: string) => (ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip);

function allowListOf(list: string): BlockList {
  const allowed = new BlockList();
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address, prefix, ...extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra.length) continue;
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      allowed.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128)) {
      allowed.addSubnet(address, bits, type);
    }
  }
  return allowed;
}

/** exact addresses and CIDR ranges, comma-separated; an empty list allows anyone */
export function ipAllowed(ip: string | undefined, list: string): boolean {
  if (!list.trim()) return true;
  if (!ip) return false;
  const address = plainAddress(ip);
  const family = isIP(address);
  if (!family) return false;
  return allowListOf(list).check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export const isIgnoredBot = (ctx: WebhookContext) => isBotUserAgent(headerValue(ctx, 'user-agent'));

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** ties a token to this login: a changed password ends the tokens issued under the old one */
const credentialDigest = (user: string, password: string) =>
  createHash('sha256').update(`${user}\0${password}`).digest('base64url');

function tokenPayload(ctx: WebhookContext, digest: string): DataObject {
  return {
    kind: BASIC_TOKEN_KIND,
    tenantId: ctx.getTenantId(),
    workflowId: ctx.getWorkflow().id ?? '',
    node: ctx.getNode().name,
    credential: digest,
  };
}

export type BasicAuthResult = { allowed: true; token: string } | { allowed: false };

/**
 * A visitor shows the login; the sandboxed page cannot, so its POST shows the token the page holds.
 * `allowToken`: the page's own GET asks for the login every time.
 */
export async function checkBasicAuth(
  ctx: WebhookContext,
  options: { allowToken: boolean },
): Promise<BasicAuthResult> {
  const creds = await ctx.getCredentials<{ user: string; password: string }>('httpBasicAuth');
  const user = String(creds.user ?? '');
  const password = String(creds.password ?? '');
  const expected = tokenPayload(ctx, credentialDigest(user, password));
  const issue = (): BasicAuthResult => ({
    allowed: true,
    token: ctx.signFormToken(expected, BASIC_TOKEN_TTL_SECONDS),
  });

  const auth = headerValue(ctx, 'authorization') ?? '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const separator = decoded.indexOf(':');
    if (
      separator >= 0 &&
      safeEqual(decoded.slice(0, separator), user) &&
      safeEqual(decoded.slice(separator + 1), password)
    ) {
      return issue();
    }
  }
  if (!options.allowToken) return { allowed: false };
  const token = headerValue(ctx, 'x-auth-token');
  const payload = token ? ctx.verifyFormToken(token) : null;
  if (!payload) return { allowed: false };
  const same = Object.entries(expected).every(([key, value]) => payload[key] === value);
  return same ? { allowed: true, token: token as string } : { allowed: false };
}
