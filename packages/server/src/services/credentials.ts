/**
 * Credential storage: AES-256-GCM via `CredentialCipher` (per-tenant keys, AAD bound to
 * tenant + credential id), redaction of secret fields for the API, and the tenant-scoped
 * `CredentialsProvider` handed to executions.
 */
import { randomUUID } from 'node:crypto';
import {
  type CredentialCipher,
  type CredentialsProvider,
  type CredentialTypeRegistry,
  mergeRedacted,
  REDACTED,
  redactCredentialData,
} from '@workflow/core';
import type { CredentialType, DataObject, NodeCredentialRef, NodeProperty } from '@workflow/workflow';
import type { CredentialRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import type { SecretsManager } from './secrets/manager';
import { collectSecretKeys, hasCredentialExpressions, resolveCredentialData } from './secrets/resolver';

/** keys never returned to the browser in clear text (OAuth token material) */
const ALWAYS_SECRET = ['oauthTokenData'];

function collectSecretFields(properties: NodeProperty[], out = new Set<string>()): Set<string> {
  for (const p of properties) {
    if (p.typeOptions?.password) out.add(p.name);
  }
  for (const k of ALWAYS_SECRET) out.add(k);
  return out;
}

export class CredentialService {
  private secrets?: Pick<SecretsManager, 'secretsFor'>;

  constructor(
    private readonly repos: Repositories,
    private readonly cipher: CredentialCipher,
    readonly types: CredentialTypeRegistry,
  ) {}

  /** where `$secrets` comes from: until this is called a read that names it fails closed */
  useSecrets(secrets: Pick<SecretsManager, 'secretsFor'>): void {
    this.secrets = secrets;
  }

  /**
   * `data` with its expressions resolved over {$secrets, $vars}. Everything that reads a credential to
   * use it comes through here (or `readResolved`); what is stored stays the expression. Errors thrown
   * have fixed texts.
   */
  async resolveData(tenantId: string, data: DataObject): Promise<DataObject> {
    if (!hasCredentialExpressions(data)) return data;
    return resolveCredentialData(data, {
      tenantId,
      vars: await this.repos.variables.map(tenantId),
      secrets: this.secrets,
    });
  }

  /** a stored credential as a node or a token call uses it. Type defaults are not expressions of the user. */
  async readResolved(row: CredentialRow): Promise<DataObject> {
    return this.withDefaults(row.type, await this.resolveData(row.tenantId, this.decrypt(row)));
  }

  private async saveSecretKeys(row: CredentialRow, data: DataObject): Promise<CredentialRow> {
    const vars = hasCredentialExpressions(data) ? await this.repos.variables.map(row.tenantId) : {};
    const secretKeys = collectSecretKeys(data, vars);
    if (secretKeys.join() === row.secretKeys.join()) return row;
    await this.repos.secrets.setCredentialSecretKeys(row.tenantId, row.id, secretKeys);
    return { ...row, secretKeys };
  }

  resolvedType(type: string): CredentialType {
    const resolved = this.types.getResolved(type);
    if (!resolved) throw ApiError.badRequest(`Unknown credential type "${type}"`);
    return resolved;
  }

  secretFields(type: string): Set<string> {
    const resolved = this.types.getResolved(type);
    return collectSecretFields(resolved?.properties ?? []);
  }

  decrypt(row: CredentialRow): DataObject {
    return this.cipher.decrypt<DataObject>(row.dataEnc, { tenantId: row.tenantId, credentialId: row.id });
  }

  encrypt(tenantId: string, credentialId: string, data: DataObject): string {
    return this.cipher.encrypt(data, { tenantId, credentialId });
  }

  /** stored data with secrets replaced by `__REDACTED__` */
  redacted(row: CredentialRow): DataObject {
    return redactCredentialData(this.decrypt(row), this.secretFields(row.type));
  }

  /**
   * the (resolved) type's defaults for properties the user left unset or blank. Hidden properties
   * are fixed by the type (Google URLs, scopes): their default always wins, except for the OAuth
   * token material, which only the OAuth2 callback writes. A base URL chosen from a list (a region)
   * must be one of the list: any other value could send the key to another host.
   */
  withDefaults(type: string, data: DataObject): DataObject {
    const resolved = this.types.getResolved(type);
    const out: DataObject = { ...data };
    for (const p of resolved?.properties ?? []) {
      if (p.type === 'notice' || p.default === undefined) continue;
      const fixed = p.type === 'hidden' && p.default !== '' && !ALWAYS_SECRET.includes(p.name);
      const current = out[p.name];
      const badChoice =
        p.type === 'options' &&
        p.name === 'url' &&
        !p.options?.some((o) => 'value' in o && o.value === current);
      if (fixed || badChoice || current === undefined || current === null || current === '') {
        out[p.name] = p.default;
      }
    }
    return out;
  }

  async create(tenantId: string, input: { name: string; type: string; data: DataObject }, userId?: string) {
    this.resolvedType(input.type);
    const id = randomUUID();
    const clean = stripSentinels(input.data);
    const row = await this.repos.credentials.create(tenantId, {
      id,
      name: input.name,
      type: input.type,
      dataEnc: this.encrypt(tenantId, id, clean),
      createdBy: userId,
    });
    return this.saveSecretKeys(row, clean);
  }

  async update(tenantId: string, id: string, patch: { name?: string; data?: DataObject }) {
    const row = await this.repos.credentials.get(tenantId, id);
    if (!row) throw ApiError.notFound('Credential');
    const update: { name?: string; dataEnc?: string } = {};
    if (patch.name !== undefined) update.name = patch.name;
    const merged = patch.data ? this.merge(this.decrypt(row), patch.data) : undefined;
    if (merged) update.dataEnc = this.encrypt(tenantId, id, merged);
    const updated = (await this.repos.credentials.update(tenantId, id, update)) ?? row;
    return merged ? this.saveSecretKeys(updated, merged) : updated;
  }

  /**
   * browser update: redacted sentinels keep stored values. Token material always comes from the
   * stored data: only the OAuth2 callback (`saveData`) writes it, never a form save.
   */
  merge(stored: DataObject, incoming: DataObject): DataObject {
    const merged = mergeRedacted(stored, incoming);
    for (const key of ALWAYS_SECRET) {
      if (key in stored) merged[key] = stored[key];
      else delete merged[key];
    }
    return stripSentinels(merged);
  }

  async saveData(tenantId: string, id: string, data: DataObject): Promise<void> {
    await this.repos.credentials.update(tenantId, id, { dataEnc: this.encrypt(tenantId, id, data) });
  }

  /** CredentialsProvider for executions of one tenant */
  provider(tenantId: string): CredentialsProvider {
    const find = async (ref: NodeCredentialRef, type: string): Promise<CredentialRow> => {
      let row = ref.id ? await this.repos.credentials.get(tenantId, ref.id) : undefined;
      if (!row && !ref.id && ref.name) {
        const candidates = this.types
          .list()
          .map((t) => t.name)
          .filter((name) => this.types.isA(name, type));
        row = await this.repos.credentials.findByName(tenantId, ref.name, candidates);
      }
      if (!row) throw new Error(`Credential "${ref.name || ref.id}" was not found`);
      if (row.type !== type && !this.types.isA(row.type, type)) {
        throw new Error(`Credential "${row.name}" is of type "${row.type}", expected "${type}"`);
      }
      return row;
    };
    return {
      get: async (ref, type) => this.readResolved(await find(ref, type)),
      // OAuth2 write-back: `data` holds resolved values, so only the new token goes into the stored object
      update: async (ref, type, data) => {
        const row = await find(ref, type);
        if (data.oauthTokenData === undefined) return;
        const stored = this.decrypt(row);
        await this.saveData(tenantId, row.id, { ...stored, oauthTokenData: data.oauthTokenData });
      },
    };
  }
}

/** never persist the redaction sentinel itself */
function stripSentinels(data: DataObject): DataObject {
  const out: DataObject = {};
  for (const [k, v] of Object.entries(data)) if (v !== REDACTED) out[k] = v;
  return out;
}
