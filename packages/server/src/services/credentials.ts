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
  constructor(
    private readonly repos: Repositories,
    private readonly cipher: CredentialCipher,
    readonly types: CredentialTypeRegistry,
  ) {}

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

  /** defaults from the (resolved) type for properties the user did not set */
  withDefaults(type: string, data: DataObject): DataObject {
    const resolved = this.types.getResolved(type);
    const out: DataObject = {};
    for (const p of resolved?.properties ?? []) {
      if (p.type === 'notice') continue;
      if (p.default !== undefined) out[p.name] = p.default;
    }
    return { ...out, ...data };
  }

  async create(tenantId: string, input: { name: string; type: string; data: DataObject }, userId?: string) {
    this.resolvedType(input.type);
    const id = randomUUID();
    const clean = stripSentinels(input.data);
    return this.repos.credentials.create(tenantId, {
      id,
      name: input.name,
      type: input.type,
      dataEnc: this.encrypt(tenantId, id, clean),
      createdBy: userId,
    });
  }

  async update(tenantId: string, id: string, patch: { name?: string; data?: DataObject }) {
    const row = await this.repos.credentials.get(tenantId, id);
    if (!row) throw ApiError.notFound('Credential');
    const update: { name?: string; dataEnc?: string } = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.data) update.dataEnc = this.encrypt(tenantId, id, this.merge(this.decrypt(row), patch.data));
    return (await this.repos.credentials.update(tenantId, id, update)) ?? row;
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
      get: async (ref, type) => {
        const row = await find(ref, type);
        return this.withDefaults(row.type, this.decrypt(row));
      },
      update: async (ref, type, data) => {
        const row = await find(ref, type);
        await this.saveData(tenantId, row.id, data);
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
