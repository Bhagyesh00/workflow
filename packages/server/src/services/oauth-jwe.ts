/**
 * P6-16 (L15): OAuth2 token responses encrypted as JWE (`jweEnabled` on `oAuth2Api`). Keys per workspace
 * in `oauth_jwe_keys` (RSA, made on first use, the private part encrypted with the binding tenant and
 * `jwe:<kid>`); `decryptResponse` uses jose `compactDecrypt` with `RSA-OAEP-256` and an allow list of
 * content algorithms, and refuses a plain response while the flag is on. `publicJwks` serves the public
 * part at `/.well-known/jwks/:slug.json`. The hook runs on the OAuth2 callback (services/oauth2.ts
 * `useJwe`), on every refresh and client credentials call of a run (`oauthTokenDecrypt`) and on the
 * credential test call (services/credential-test.ts).
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import {
  type CompactJWEHeaderParameters,
  compactDecrypt,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
} from 'jose';
import type { ServiceDeps } from '../context';

/** the only key management algorithm (as n8n) */
const KEY_ALGORITHM = 'RSA-OAEP-256';
/** content encryption algorithms accepted for a token */
const CONTENT_ALGORITHMS = [
  'A128GCM',
  'A192GCM',
  'A256GCM',
  'A128CBC-HS256',
  'A192CBC-HS384',
  'A256CBC-HS512',
];
/** the token response fields that may carry a JWE */
const TOKEN_FIELDS = ['access_token', 'refresh_token', 'id_token'] as const;
const MAX_JWE_LENGTH = 64 * 1024;

const COMPACT_JWE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** a compact JWE has five dot-separated base64url parts and a header that names `enc` */
function looksLikeJwe(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_JWE_LENGTH || !COMPACT_JWE.test(value)) return false;
  try {
    const header = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8')) as {
      enc?: unknown;
    };
    return typeof header.enc === 'string';
  } catch {
    return false;
  }
}

export class OAuthJweService {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * The token response with its JWE fields decrypted. Without `jweEnabled` the token is returned as it came.
   * With it, at least one of the token fields must be a JWE that opens with this workspace's key; a plain
   * response, a wrong algorithm (including `alg: none`) or a foreign key throws.
   */
  async decryptResponse(tenantId: string, token: DataObject, data: DataObject): Promise<DataObject> {
    if (data.jweEnabled !== true) return token;
    const out: DataObject = { ...token };
    let decrypted = 0;
    const rows = await this.deps.repos.jweKeys.list(tenantId);
    const keys = new Map<string, Awaited<ReturnType<typeof importPKCS8>>>();
    const keyOf = async (row: (typeof rows)[number]) => {
      let key = keys.get(row.kid);
      if (!key) {
        const pem = this.deps.context().cipher.decrypt<string>(row.privateEnc, {
          tenantId,
          credentialId: `jwe:${row.kid}`,
        });
        key = await importPKCS8(pem, KEY_ALGORITHM);
        keys.set(row.kid, key);
      }
      return key;
    };
    const resolveKey = async (header: CompactJWEHeaderParameters) => {
      const row = rows.find((r) => r.kid === header.kid);
      if (!row) throw new Error('no key');
      return keyOf(row);
    };
    const options = {
      keyManagementAlgorithms: [KEY_ALGORITHM],
      contentEncryptionAlgorithms: CONTENT_ALGORITHMS,
    };
    /** the key named by `kid`; a JWE without `kid` is tried against each of the workspace's keys in turn */
    const open = async (value: string) => {
      const kid = (
        JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8')) as { kid?: unknown }
      ).kid;
      if (typeof kid === 'string' && kid) return compactDecrypt(value, resolveKey, options);
      for (const row of rows) {
        try {
          return await compactDecrypt(value, await keyOf(row), options);
        } catch {
          // try the next key
        }
      }
      throw new Error('no key');
    };
    for (const field of TOKEN_FIELDS) {
      const value = token[field];
      if (!looksLikeJwe(value)) continue;
      try {
        const { plaintext } = await open(value);
        out[field] = new TextDecoder().decode(plaintext);
        decrypted += 1;
      } catch {
        throw new Error(`Couldn't decrypt the ${field} of the token response`);
      }
    }
    if (decrypted === 0) {
      throw new Error('The token response holds no encrypted token, but encrypted tokens are turned on');
    }
    return out;
  }

  /** the workspace's public keys as a JWK set; undefined for an unknown slug. Makes the first key on first use. */
  async publicJwks(slug: string): Promise<{ keys: DataObject[] } | undefined> {
    const tenant = await this.deps.repos.tenants.getBySlug(slug);
    if (!tenant) return undefined;
    let rows = await this.deps.repos.jweKeys.list(tenant.id);
    // first fetches that arrive together make one key: the insert holds a per-workspace lock and re-lists
    if (rows.length === 0) rows = await this.createKey(tenant.id);
    return { keys: rows.map((r) => ({ ...r.publicJwk }) as DataObject) };
  }

  private async createKey(tenantId: string) {
    const { publicKey, privateKey } = await generateKeyPair(KEY_ALGORITHM, {
      modulusLength: 2048,
      extractable: true,
    });
    const kid = randomUUID();
    const publicJwk = { ...(await exportJWK(publicKey)), kid, use: 'enc', alg: KEY_ALGORITHM };
    const pem = await exportPKCS8(privateKey);
    const privateEnc = this.deps.context().cipher.encrypt(pem, { tenantId, credentialId: `jwe:${kid}` });
    return this.deps.repos.jweKeys.createIfNone(tenantId, { kid, privateEnc, publicJwk });
  }
}
