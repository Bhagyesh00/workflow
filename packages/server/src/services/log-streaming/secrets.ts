/**
 * P6-06 (S5 L3): the secret fields of a destination (`DESTINATION_SECRET_FIELDS`) split from its settings on save
 * and merged back for the sender; stored through `ctx.cipher` with binding
 * `{ tenantId, credentialId: 'logDestination:<id>' }`, blank on read. A blank on save keeps the stored value only
 * while the scheme, host and port of the webhook URL or Sentry DSN are unchanged.
 *
 * A secret is addressed by a slot key that names the field and, for lists, the pair's name and its occurrence
 * (`headerParameters[].value:X-Token#0`), so a reordered list still finds its values. The secret values:
 * - webhook: each non-empty value of the URL's query, each `headerParameters[].value`, each
 *   `queryParameters[].value`, and the password of a `user:password@` part of the URL (the user name stays)
 * - sentry: the public key of the DSN (its user part) and a legacy secret key after it
 * A blank slot is an empty value (`name=` in a URL, `''` in a pair, `https://@host/1` for a DSN).
 */
import type { LogDestinationType } from '@workflow/workflow';

export interface SplitSecrets {
  /** the settings with every secret value blank */
  settings: Record<string, unknown>;
  /** the secret values by slot key */
  secrets: Record<string, string>;
}

/** the cipher binding of a destination's secrets */
export function destinationSecretBinding(tenantId: string, destinationId: string) {
  return { tenantId, credentialId: `logDestination:${destinationId}` };
}

const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/)(?:([^/?#@]*)@)?([^?#]*)(?:\?([^#]*))?(#.*)?$/i;

interface UrlParts {
  scheme: string;
  /** the text before the `@`, or null when there is none */
  userinfo: string | null;
  /** host, port and path */
  rest: string;
  /** the raw query, or null when there is no `?` */
  query: string | null;
  hash: string;
}

function parseUrl(url: string): UrlParts | null {
  const match = URL_PARTS.exec(url);
  if (!match) return null;
  return {
    scheme: match[1],
    userinfo: match[2] ?? null,
    rest: match[3] ?? '',
    query: match[4] ?? null,
    hash: match[5] ?? '',
  };
}

function buildUrl(parts: UrlParts): string {
  return `${parts.scheme}${parts.userinfo === null ? '' : `${parts.userinfo}@`}${parts.rest}${
    parts.query === null ? '' : `?${parts.query}`
  }${parts.hash}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** a slot: where a secret sits, its key, and the value as it is now */
interface Slot {
  key: string;
  value: string;
  /** writes a replacement into the (copied) settings */
  write(settings: Record<string, unknown>, value: string): void;
}

/** the `name#occurrence` keys of a list of names */
function occurrences(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return `${name}#${count}`;
  });
}

function pairSlots(settings: Record<string, unknown>, field: string): Slot[] {
  const list = settings[field];
  if (!Array.isArray(list)) return [];
  const names = list.map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''));
  const keys = occurrences(names);
  const slots: Slot[] = [];
  list.forEach((item, index) => {
    if (!isRecord(item) || typeof item.value !== 'string') return;
    slots.push({
      key: `${field}[].value:${keys[index]}`,
      value: item.value,
      write(target, value) {
        const copy = target[field] as Array<Record<string, unknown>>;
        copy[index] = { ...copy[index], value };
      },
    });
  });
  return slots;
}

function urlSlots(url: unknown): Slot[] {
  if (typeof url !== 'string') return [];
  const parts = parseUrl(url);
  if (!parts) return [];
  const slots: Slot[] = [];
  const rewrite = (edit: (next: UrlParts) => void) => (target: Record<string, unknown>) => {
    const next = parseUrl(target.url as string);
    if (!next) return;
    edit(next);
    target.url = buildUrl(next);
  };
  if (parts.userinfo?.includes(':')) {
    const colon = parts.userinfo.indexOf(':');
    slots.push({
      key: 'url.password',
      value: parts.userinfo.slice(colon + 1),
      write: (target, value) =>
        rewrite((next) => {
          const at = (next.userinfo ?? '').indexOf(':');
          if (at >= 0) next.userinfo = `${(next.userinfo as string).slice(0, at)}:${value}`;
        })(target),
    });
  }
  if (parts.query !== null) {
    const params = parts.query.split('&');
    const names = params.map((param) => (param.includes('=') ? param.slice(0, param.indexOf('=')) : null));
    const keys = occurrences(names.map((name) => name ?? ''));
    params.forEach((param, index) => {
      const name = names[index];
      if (name === null) return;
      slots.push({
        key: `url.query:${keys[index]}`,
        value: param.slice(name.length + 1),
        write: (target, value) =>
          rewrite((next) => {
            const all = (next.query ?? '').split('&');
            if (index < all.length) all[index] = `${name}=${value}`;
            next.query = all.join('&');
          })(target),
      });
    });
  }
  return slots;
}

const DSN = /^([a-z][a-z0-9+.-]*:\/\/)(?:([^:@/]*)(?::([^@/]*))?@)?(.*)$/i;

function dsnSlots(dsn: unknown): Slot[] {
  if (typeof dsn !== 'string') return [];
  const match = DSN.exec(dsn);
  if (!match) return [];
  const [, scheme, publicKey, secretKey, rest] = match;
  const build = (key: string, secret: string | undefined) =>
    `${scheme}${key}${secret === undefined ? '' : `:${secret}`}@${rest}`;
  const slots: Slot[] = [
    {
      key: 'dsn.publicKey',
      value: publicKey ?? '',
      write(target, value) {
        const current = DSN.exec(target.dsn as string);
        if (current) target.dsn = build(value, current[3]);
      },
    },
  ];
  if (secretKey !== undefined) {
    slots.push({
      key: 'dsn.secretKey',
      value: secretKey,
      write(target, value) {
        const current = DSN.exec(target.dsn as string);
        if (current) target.dsn = build(current[2] ?? '', value);
      },
    });
  }
  return slots;
}

function slotsOf(type: LogDestinationType, settings: Record<string, unknown>): Slot[] {
  if (type === 'webhook') {
    return [
      ...urlSlots(settings.url),
      ...pairSlots(settings, 'headerParameters'),
      ...pairSlots(settings, 'queryParameters'),
    ];
  }
  if (type === 'sentry') return dsnSlots(settings.dsn);
  return [];
}

/** a deep copy the slots can write into */
function copyOf(settings: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(settings);
}

export function splitDestinationSecrets(
  type: LogDestinationType,
  settings: Record<string, unknown>,
): SplitSecrets {
  const out = copyOf(settings);
  const secrets: Record<string, string> = {};
  // slots are read from the original and written to the copy (each write finds its place again)
  const slots = slotsOf(type, settings);
  for (const slot of slots) if (slot.value !== '') secrets[slot.key] = slot.value;
  for (const slot of slots) if (slot.value !== '') slot.write(out, '');
  return { settings: out, secrets };
}

export function mergeDestinationSecrets(
  type: LogDestinationType,
  settings: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  const out = copyOf(settings);
  for (const slot of slotsOf(type, settings)) {
    if (slot.value === '' && Object.hasOwn(secrets, slot.key)) slot.write(out, secrets[slot.key]);
  }
  return out;
}

/** the slot keys that are blank in `settings` (a save with these keeps the stored values of the same keys) */
export function blankSecretKeys(type: LogDestinationType, settings: Record<string, unknown>): string[] {
  return slotsOf(type, settings)
    .filter((slot) => slot.value === '')
    .map((slot) => slot.key);
}

/**
 * The endpoint stored secrets belong to: scheme, host and port of the webhook URL or Sentry DSN (default ports
 * made explicit). null for a type with no secrets or an address that does not parse.
 */
export function destinationEndpoint(
  type: LogDestinationType,
  settings: Record<string, unknown>,
): string | null {
  const address = type === 'webhook' ? settings.url : type === 'sentry' ? settings.dsn : undefined;
  if (typeof address !== 'string') return null;
  const match = DSN.exec(address);
  if (!match) return null;
  try {
    const url = new URL(`${match[1]}${match[4]}`);
    const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}
