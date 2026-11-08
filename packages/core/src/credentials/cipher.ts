/**
 * Credential encryption: AES-256-GCM with per-tenant keys derived from a master key via HKDF.
 * The ciphertext is bound to (tenantId, credentialId) as additional authenticated data, so a
 * ciphertext copied into another tenant's or credential's row fails to decrypt.
 *
 * Format: `v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>`
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { type NodeProperty, type NodePropertyCollection, splitTemplate } from '@workflow/workflow';

export interface MasterKey {
  id: string;
  /** 32 bytes */
  key: Buffer;
}

export class CredentialCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly primary: MasterKey;

  /** first key encrypts; all keys can decrypt (rotation) */
  constructor(keys: MasterKey[]) {
    if (!keys.length) throw new Error('At least one master key is required');
    for (const k of keys) {
      if (k.key.length !== 32) throw new Error(`Master key "${k.id}" must be 32 bytes`);
      if (k.id.includes('.')) throw new Error('Master key id must not contain "."');
      this.keys.set(k.id, k.key);
    }
    this.primary = keys[0];
  }

  /** parse `ENCRYPTION_KEYS="id1:base64key,id2:base64key"` */
  static fromEnv(value: string | undefined): CredentialCipher {
    if (!value) throw new Error('ENCRYPTION_KEYS is not set');
    return new CredentialCipher(
      value.split(',').map((entry) => {
        const [id, b64] = entry.trim().split(':');
        return { id, key: Buffer.from(b64, 'base64') };
      }),
    );
  }

  private tenantKey(masterKey: Buffer, tenantId: string): Buffer {
    return Buffer.from(
      hkdfSync('sha256', masterKey, Buffer.from(tenantId), Buffer.from('credentials:v1'), 32),
    );
  }

  encrypt(data: unknown, binding: { tenantId: string; credentialId: string }): string {
    const key = this.tenantKey(this.primary.key, binding.tenantId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${binding.tenantId}:${binding.credentialId}`));
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.primary.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
  }

  decrypt<T = unknown>(payload: string, binding: { tenantId: string; credentialId: string }): T {
    const [version, keyId, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1') throw new Error('Unsupported credential ciphertext version');
    const master = this.keys.get(keyId);
    if (!master) throw new Error(`Unknown encryption key "${keyId}"`);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.tenantKey(master, binding.tenantId),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`${binding.tenantId}:${binding.credentialId}`));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  }

  /** true when the payload was encrypted with a non-primary key and should be re-encrypted */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.primary.id;
  }
}

/** Replace secret values with a sentinel before sending credential data to the browser. */
export const REDACTED = '__REDACTED__';

/**
 * An expression in a credential field: `=` and at least one closed `{{ }}`. Anything else is a literal,
 * because a typed password may begin with `=` or hold an open `{{`.
 */
export function isCredentialExpression(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('=') &&
    splitTemplate(value.slice(1)).some((segment) => segment.type === 'code')
  );
}

type Data = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const redactValue = (value: unknown): unknown =>
  value === '' || value === undefined || value === null || isCredentialExpression(value) ? value : REDACTED;

/** the value of one property with its password-typed values redacted, also inside (fixed) collections */
function redactProperty(value: unknown, property: NodeProperty): unknown {
  if (property.typeOptions?.password) return redactValue(value);
  if (!isPlainObject(value)) return value;
  if (property.type === 'collection') {
    const options = (property.options ?? []).filter((o): o is NodeProperty => 'type' in o);
    return redactProperties(value, options);
  }
  if (property.type !== 'fixedCollection') return value;
  const out: Data = { ...value };
  for (const option of property.options ?? []) {
    if (!('values' in option) || !(option.name in value)) continue;
    const { values } = option as NodePropertyCollection;
    const entry = value[option.name];
    const redactEntry = (item: unknown) => (isPlainObject(item) ? redactProperties(item, values) : item);
    out[option.name] = Array.isArray(entry) ? entry.map(redactEntry) : redactEntry(entry);
  }
  return out;
}

function redactProperties(data: Data, properties: readonly NodeProperty[]): Data {
  const out: Data = { ...data };
  for (const property of properties) {
    if (property.name in out) out[property.name] = redactProperty(out[property.name], property);
  }
  return out;
}

/**
 * An expression stays visible: it is a reference such as `={{ $secrets.vault.key }}`, not the secret.
 * With `properties` (the credential type's), password-typed values inside a collection or fixedCollection
 * are redacted too, such as the header values of Multiple Headers Auth.
 */
export function redactCredentialData(
  data: Record<string, unknown>,
  secretFields: Set<string>,
  properties?: readonly NodeProperty[],
): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = secretFields.has(k) ? redactValue(v) : v;
  }
  if (properties) {
    const nested = properties.filter(
      (p) => (p.type === 'collection' || p.type === 'fixedCollection') && !secretFields.has(p.name),
    );
    out = redactProperties(out, nested);
  }
  return out;
}

/** a nested value from the browser with each sentinel replaced by the stored value at the same place */
function restoreNested(incoming: unknown, stored: unknown): unknown {
  if (Array.isArray(incoming)) {
    const from = Array.isArray(stored) ? stored : [];
    return incoming.map((item, i) => (item === REDACTED ? from[i] : restoreNested(item, from[i])));
  }
  if (!isPlainObject(incoming)) return incoming;
  const from = isPlainObject(stored) ? stored : {};
  const out: Data = { ...incoming };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== REDACTED) out[k] = restoreNested(v, from[k]);
    else if (k in from) out[k] = from[k];
    else delete out[k];
  }
  return out;
}

/**
 * Merge an update from the browser, keeping stored secrets where the client sent the sentinel, also inside
 * nested objects and lists (matched by key and position).
 */
export function mergeRedacted(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const [k, v] of Object.entries(incoming)) {
    out[k] = v === REDACTED ? stored[k] : restoreNested(v, stored[k]);
  }
  return out;
}
