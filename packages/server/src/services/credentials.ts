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
import type { ServiceDeps } from '../context';
import type { CredentialRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import { AccessService } from './access';
import type { SecretsManager } from './secrets/manager';
import { collectSecretKeys, hasCredentialExpressions, resolveCredentialData } from './secrets/resolver';
import { assertCredentialType } from './type-policies/enforce';
import { PolicyCheckFailedError } from './type-policies/errors';

/** keys never returned to the browser in clear text (OAuth token material) */
const ALWAYS_SECRET = ['oauthTokenData'];

function collectSecretFields(properties: NodeProperty[], out = new Set<string>()): Set<string> {
  for (const p of properties) {
    if (p.typeOptions?.password) out.add(p.name);
  }
  for (const k of ALWAYS_SECRET) out.add(k);
  return out;
}

/** the failure a run sees for a credential it may not use: the same text as a missing one (no oracle) */
function notFound(ref: NodeCredentialRef): Error {
  return new Error(`Credential "${ref.name || ref.id}" was not found`);
}

/**
 * P6-15: a private credential in a run that no user started (a schedule, a webhook without sign-in), as n8n's
 * credentials helper refuses a resolvable credential without an identity. No fallback to the shared data.
 */
export function privateWithoutUserError(name: string): Error {
  return new Error(
    `Credential "${name}" is private: each user connects their own account, and this run was not started by a signed-in user`,
  );
}

/** P6-15: the user the run acts for has not connected their own account to the private credential */
export function privateNotConnectedError(name: string): Error {
  return new Error(
    `Credential "${name}" is not connected for this user. Connect your own account in the credential.`,
  );
}

/** the shared fields of a credential (token material left out), to see whether a save changed one */
function sharedFields(data: DataObject): string {
  const keys = Object.keys(data)
    .filter((key) => !ALWAYS_SECRET.includes(key))
    .sort();
  return JSON.stringify(keys.map((key) => [key, data[key]]));
}

/**
 * What a run's credential lookup gets (`provider`). P6-15: a private credential uses the entry of
 * `endUserId` and marks `executionId` as a run that used one; `startNode` is the credential gate's (P6-87).
 */
export interface CredentialProviderOptions {
  /** credential ids a server path allows beyond the project's own (never from a node or a body) */
  allow?: string[];
  /** the person the run acts for (a manual run's user, a signed-in trigger's user) */
  endUserId?: string;
  executionId?: string;
  startNode?: string;
}

export class CredentialService {
  private secrets?: Pick<SecretsManager, 'secretsFor'>;
  private accessService?: AccessService;
  /** P6 S3 (C0): the type policy checks' deps; until `setPolicyDeps` runs, `create` fails closed */
  private policyDeps?: ServiceDeps;

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
   * P6 S3 (C0): where the type policy checks read from (context.ts calls it right after construction).
   * Until it runs, `create` fails closed with `PolicyCheckFailedError` (503), never passes.
   */
  setPolicyDeps(deps: ServiceDeps): void {
    this.policyDeps = deps;
  }

  /** the policy deps, or the fail-closed refusal at `point` */
  protected requirePolicyDeps(point: 'credentialSave'): ServiceDeps {
    if (!this.policyDeps) throw new PolicyCheckFailedError(point);
    return this.policyDeps;
  }

  /** the scope rules (P6-03), read from the repositories this service holds */
  private get access(): AccessService {
    this.accessService ??= new AccessService(this.repos);
    return this.accessService;
  }

  /**
   * P6-24: whether `userId` may still write the credential (`credential:update` on it), as the OAuth
   * callbacks check for the user of their signed state. A credential that is gone is the 404 of the lookup.
   */
  async userMayUpdate(tenantId: string, userId: string, credentialId: string): Promise<boolean> {
    const scopes = await this.access.scopesFor(tenantId, userId, { credentialId });
    return scopes.has('credential:update');
  }

  /**
   * P6-15: whether `userId` may still connect their own account to the credential (`credential:connect` on
   * it), as the per user OAuth callbacks check for the user of their signed state.
   */
  async userMayConnect(tenantId: string, userId: string, credentialId: string): Promise<boolean> {
    const scopes = await this.access.scopesFor(tenantId, userId, { credentialId });
    return scopes.has('credential:connect');
  }

  /**
   * `data` with its expressions resolved over {$secrets, $vars}. Everything that reads a credential to
   * use it comes through here (or `readResolved`); what is stored stays the expression. Errors thrown
   * have fixed texts.
   */
  async resolveData(tenantId: string, projectId: string | null, data: DataObject): Promise<DataObject> {
    if (!hasCredentialExpressions(data)) return data;
    // P6 S1: `projectId` is the credential's project (null for a body with no project): its `$vars` and
    // `$secrets`; the vaults a project may read are L8's (`SecretsManager.secretsFor`)
    return resolveCredentialData(data, {
      tenantId,
      projectId,
      vars: await this.repos.variables.map(tenantId, projectId ?? undefined),
      secrets: this.secrets,
    });
  }

  /** a stored credential as a node or a token call uses it. Type defaults are not expressions of the user. */
  async readResolved(row: CredentialRow): Promise<DataObject> {
    return this.withDefaults(
      row.type,
      await this.resolveData(row.tenantId, row.projectId, this.decrypt(row)),
    );
  }

  private async saveSecretKeys(row: CredentialRow, data: DataObject): Promise<CredentialRow> {
    const vars = hasCredentialExpressions(data)
      ? await this.repos.variables.map(row.tenantId, row.projectId)
      : {};
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

  /** P6-15: OAuth1 and OAuth2 types (and their children) are the only ones that can be private */
  isOAuthType(type: string): boolean {
    return this.types.isA(type, 'oAuth2Api') || this.types.isA(type, 'oAuth1Api');
  }

  /** P6-15: a private entry is bound to its credential and its user, so no entry decrypts as another's */
  private entryBinding(tenantId: string, credentialId: string, userId: string) {
    return { tenantId, credentialId: `${credentialId}:user:${userId}` };
  }

  /** P6-15: the member's own connection of a private credential (its token data), decrypted */
  async readEntry(tenantId: string, credentialId: string, userId: string): Promise<DataObject | undefined> {
    const entry = await this.repos.credentialEntries.get(tenantId, credentialId, userId);
    if (!entry) return undefined;
    return this.cipher.decrypt<DataObject>(entry.dataEnc, this.entryBinding(tenantId, credentialId, userId));
  }

  /** P6-15: writes the member's own connection; the shared row is never touched */
  async saveEntry(tenantId: string, credentialId: string, userId: string, data: DataObject): Promise<void> {
    const dataEnc = this.cipher.encrypt(data, this.entryBinding(tenantId, credentialId, userId));
    await this.repos.credentialEntries.save(tenantId, credentialId, userId, dataEnc);
  }

  encrypt(tenantId: string, credentialId: string, data: DataObject): string {
    return this.cipher.encrypt(data, { tenantId, credentialId });
  }

  /** stored data with secrets replaced by `__REDACTED__`, also inside (fixed) collections */
  redacted(row: CredentialRow): DataObject {
    const properties = this.types.getResolved(row.type)?.properties ?? [];
    return redactCredentialData(this.decrypt(row), this.secretFields(row.type), properties);
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

  /** `isResolvable` (P6-15): the route checked the type, the project and `credential:createEndUser` */
  async create(
    tenantId: string,
    input: { name: string; type: string; data: DataObject; projectId: string; isResolvable?: boolean },
    userId?: string,
  ) {
    this.resolvedType(input.type);
    // P6 S3: fails closed until `setPolicyDeps`, then the type policy refuses creating a blocked type (P6-04)
    const policyDeps = this.requirePolicyDeps('credentialSave');
    // P6 S1: the project the caller resolved (`AccessService.targetProject`)
    const { projectId } = input;
    await assertCredentialType(policyDeps, 'credentialSave', {
      tenantId,
      projectId,
      type: input.type,
      isNew: true,
    });
    const id = randomUUID();
    const clean = stripSentinels(input.data);
    const row = await this.repos.credentials.create(tenantId, {
      id,
      name: input.name,
      type: input.type,
      dataEnc: this.encrypt(tenantId, id, clean),
      projectId,
      createdBy: userId,
    });
    const saved = await this.saveSecretKeys(row, clean);
    if (!input.isResolvable) return saved;
    await this.repos.credentialEntries.setResolvable(tenantId, id, true);
    return { ...saved, isResolvable: true };
  }

  /**
   * `isGlobal` (P6-24): the route checks `credential:shareGlobally` before it passes the flag. `isResolvable`
   * (P6-15): the route checked the type, the project and `credential:createEndUser`. As n8n, a switch back to
   * fixed deletes every user's connection, and so does a change of a shared field (client id, URLs, scope)
   * of a private credential: the connections were made against the old values.
   */
  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; data?: DataObject; isGlobal?: boolean; isResolvable?: boolean },
  ) {
    const row = await this.repos.credentials.get(tenantId, id);
    if (!row) throw ApiError.notFound('Credential');
    const update: { name?: string; dataEnc?: string; isGlobal?: boolean } = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.isGlobal !== undefined) update.isGlobal = patch.isGlobal;
    const stored = patch.data ? this.decrypt(row) : undefined;
    const merged = stored && patch.data ? this.merge(stored, patch.data) : undefined;
    if (merged) update.dataEnc = this.encrypt(tenantId, id, merged);
    const updated = (await this.repos.credentials.update(tenantId, id, update)) ?? row;
    const isResolvable = patch.isResolvable ?? row.isResolvable;
    if (isResolvable !== row.isResolvable) {
      await this.repos.credentialEntries.setResolvable(tenantId, id, isResolvable);
    }
    const sharedChanged = !!stored && !!merged && sharedFields(stored) !== sharedFields(merged);
    if (row.isResolvable && (!isResolvable || sharedChanged)) {
      await this.repos.credentialEntries.deleteForCredential(tenantId, id);
    }
    const out = { ...updated, isResolvable };
    return merged ? this.saveSecretKeys(out, merged) : out;
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

  /**
   * CredentialsProvider for the runs of one project (P6-24, the worst case of the phase). A row is used only
   * when it is owned by `projectId`, shared with it, global, or in `options.allow` (ids a server path passes
   * for workspace-level settings, never a node's or a body's); a name is looked up only among what the project
   * can use, its own rows first. Anything else fails as a missing credential would. The OAuth2 write-back
   * goes through the same lookup.
   *
   * P6-15: a private credential uses the connection of `options.endUserId` merged over the shared fields
   * (`{ ...shared, ...entry }`); with no user, or no connection of that user, the node fails (no fallback to
   * the shared data). A refreshed token goes to that user's entry, never to the shared row. The first use
   * marks the run (`executions.used_private_credentials`); the entry itself never enters run data.
   */
  provider(
    tenantId: string,
    projectId: string,
    options: CredentialProviderOptions = {},
  ): CredentialsProvider {
    const allow = [...(options.allow ?? [])];
    const find = async (ref: NodeCredentialRef, type: string): Promise<CredentialRow> => {
      let row = ref.id ? await this.repos.credentials.get(tenantId, ref.id) : undefined;
      if (!row && !ref.id && ref.name) {
        const candidates = this.types
          .list()
          .map((t) => t.name)
          .filter((name) => this.types.isA(name, type));
        row = await this.repos.credentials.findByName(tenantId, projectId, ref.name, candidates);
      }
      if (!row || !(await this.access.credentialUsable(tenantId, projectId, row, allow))) throw notFound(ref);
      if (row.type !== type && !this.types.isA(row.type, type)) {
        throw new Error(`Credential "${row.name}" is of type "${row.type}", expected "${type}"`);
      }
      return row;
    };
    const { endUserId, executionId } = options;
    let marked = false;
    const entryOf = async (row: CredentialRow): Promise<{ userId: string; entry: DataObject }> => {
      if (!endUserId) throw privateWithoutUserError(row.name);
      const entry = await this.readEntry(tenantId, row.id, endUserId);
      if (!entry) throw privateNotConnectedError(row.name);
      if (executionId && !marked) {
        marked = true;
        await this.repos.credentialEntries.markExecutionUsed(tenantId, executionId);
      }
      return { userId: endUserId, entry };
    };
    return {
      get: async (ref, type) => {
        const row = await find(ref, type);
        if (!row.isResolvable) return this.readResolved(row);
        const { entry } = await entryOf(row);
        return { ...(await this.readResolved(row)), ...entry };
      },
      // OAuth2 write-back: `data` holds resolved values, so only the new token goes into the stored object
      update: async (ref, type, data) => {
        const row = await find(ref, type);
        if (data.oauthTokenData === undefined) return;
        if (row.isResolvable) {
          const { userId, entry } = await entryOf(row);
          await this.saveEntry(tenantId, row.id, userId, { ...entry, oauthTokenData: data.oauthTokenData });
          return;
        }
        const stored = this.decrypt(row);
        await this.saveData(tenantId, row.id, { ...stored, oauthTokenData: data.oauthTokenData });
      },
    };
  }
}

/** never persist the redaction sentinel itself, also inside (fixed) collections */
function stripSentinels(data: DataObject): DataObject {
  const out: DataObject = {};
  for (const [k, v] of Object.entries(data)) if (v !== REDACTED) out[k] = stripNested(v);
  return out;
}

function stripNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === REDACTED ? '' : stripNested(item)));
  if (typeof value !== 'object' || value === null) return value;
  return stripSentinels(value as DataObject);
}
