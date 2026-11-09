/**
 * External secrets manager (P4-07): the registry of provider types, the per-tenant connections and
 * the cache of live providers on every main and worker process. The cache is loaded before jobs start,
 * refreshed on a timer, and a change on one instance reaches the others on the bus. Secret values stay
 * inside the providers: logs, errors, audit rows and the bus carry names and fixed texts only.
 *
 * P6-28 project vaults: a connection is owned by a project (`project_id`), shared with projects
 * (`project_secret_access`), or tenant wide (no owner and no share). `$secrets` of a credential reads only
 * what its home project reaches; each process keeps that access list next to its cache, reloads it on
 * the reload channel and rebuilds it on every timer tick.
 */
import { randomUUID } from 'node:crypto';
import { mergeRedacted, REDACTED } from '@workflow/core';
import {
  BLOCKED_KEYS,
  type DataObject,
  EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES,
  RESOURCE_ROLE_SCOPES,
  type Scope,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SecretConnectionRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { toWorkflowLogger } from '../../logger';
import { createRepositories, isUniqueViolation, pgErrorCode, type Repositories } from '../../repositories';
import type { SecretConnectionShare } from '../../repositories/secrets';
import { isUuid } from '../../repositories/util';
import { SecretsCache } from './cache';
import { SECRET_PROVIDER_TYPES } from './providers';
import { createSecretsProxy, type SecretsObject } from './proxy';
import { backoffDelayMs, TimeoutError, withTimeout } from './retry';
import type {
  SecretActor,
  SecretConnectionCreateInput,
  SecretConnectionDTO,
  SecretConnectionProject,
  SecretConnectionReach,
  SecretConnectionTestResult,
  SecretConnectionUpdateInput,
  SecretProvider,
  SecretProviderDeps,
  SecretProviderSettings,
  SecretProviderState,
  SecretProviderType,
} from './types';

export const RELOAD_CHANNEL = 'secrets:reload';
/** connections connected at once, at startup and on a timer tick */
const CONCURRENCY = 10;
const DISCONNECT_TIMEOUT_MS = 5000;

const TEXT_UNKNOWN_TYPE = 'This connection type is not available';
const TEXT_BAD_SETTINGS = 'The connection settings are not valid';
const TEXT_UNREADABLE = "Couldn't read the connection settings";
const TEXT_TIMEOUT = 'The vault did not answer in time';
const TEXT_CONNECT = "Couldn't connect to the vault";
const TEXT_REFRESH = "Couldn't read the secrets from the vault";
const TEXT_TEST = "Couldn't test the connection";
/** n8n's texts (secret-provider-access-check.service.ee.ts) */
const TEXT_LOW_ACCESS = 'Project does not have the required access level for this connection';
const OWNER_ROLE = 'secretsProviderConnection:owner';

/**
 * A provider's thrown error may quote a response, so its message is not used. A provider marks a fixed
 * text by throwing an error with this name; anything else gets the fallback.
 */
function fixedText(error: unknown, fallback: string): string {
  if (error instanceof TimeoutError) return error.message;
  const e = error as { name?: unknown; message?: unknown } | undefined;
  if (e?.name === 'SecretProviderError' && typeof e.message === 'string') return e.message.slice(0, 300);
  return fallback;
}

/** one enabled connection on this process */
interface LiveConnection {
  tenantId: string;
  providerKey: string;
  type: string;
  /** the row's updatedAt this copy was built from */
  version: number;
  state: SecretProviderState;
  lastError: string | null;
  attempt: number;
  retry?: NodeJS.Timeout;
  /** a newer connect makes an older one discard its result */
  generation: number;
}

const liveId = (tenantId: string, providerKey: string) => `${tenantId}\0${providerKey}`;

/** the access list entry of one connection; `seq` orders the reads, so an older read never wins */
interface ReachEntry extends SecretConnectionReach {
  seq: number;
}

/** the system project roles the `externalSecrets.systemRolesEnabled` switch widens */
const isSwitchRole = (role: string | undefined): role is keyof typeof EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES =>
  role === 'project:admin' || role === 'project:editor';

/** never holds up a swap or the shutdown, and its error says nothing to anyone */
async function disconnect(provider: SecretProvider | undefined): Promise<void> {
  if (!provider) return;
  try {
    await withTimeout(provider.disconnect(), DISCONNECT_TIMEOUT_MS, TEXT_TIMEOUT);
  } catch {
    // the provider is out of the cache either way
  }
}

export interface SecretsManagerOptions {
  /** added to the six; one with the same name replaces it (tests add a fake vault) */
  secretProviderTypes?: SecretProviderType[];
}

export class SecretsManager {
  private readonly types = new Map<string, SecretProviderType>();
  private readonly cache = new SecretsCache();
  private readonly live = new Map<string, LiveConnection>();
  /** P6-28: which projects reach each connection of this process (key: `liveId`) */
  private readonly reach = new Map<string, ReachEntry>();
  private reachSeq = 0;
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private running = false;
  private stopped = false;
  private ticking = false;
  /** a stop ends the background part of the load that began before it */
  private loadRun = 0;

  constructor(
    readonly deps: ServiceDeps,
    options: SecretsManagerOptions = {},
  ) {
    for (const type of [...SECRET_PROVIDER_TYPES, ...(options.secretProviderTypes ?? [])]) {
      this.types.set(type.name, type);
    }
  }

  /**
   * Load the cache, start the refresh timer and the bus reload. Runs before jobs start. A vault or
   * database that fails here must not stop the server: the timer picks it up. Vaults that do not answer
   * must not hold it up either: the wait has a limit, and what is left connects in the background.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    try {
      const { bus, credentials } = this.deps.context();
      credentials.useSecrets(this);
      this.unsubscribe = await bus.subscribe(RELOAD_CHANNEL, (message) => {
        void this.onReloadMessage(message);
      });
      this.timer = setInterval(
        () => void this.tick(),
        this.deps.config.externalSecrets.updateIntervalS * 1000,
      );
      this.timer.unref();
      await this.loadWithinLimit();
    } catch (error) {
      this.logLoadFailure(error);
    }
  }

  private logLoadFailure(error: unknown): void {
    this.deps.logger?.error({ code: pgErrorCode(error) }, 'Could not load the external secret connections');
  }

  private async loadWithinLimit(): Promise<void> {
    const load = this.loadEnabled().catch((error: unknown) => this.logLoadFailure(error));
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.connectTimeoutMs() + this.refreshTimeoutMs());
      timer.unref();
    });
    await Promise.race([load, limit]);
    clearTimeout(timer);
  }

  /** Stop the timer and disconnect every provider. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.loadRun++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const live of this.live.values()) {
      live.generation++;
      clearTimeout(live.retry);
    }
    this.live.clear();
    this.reach.clear();
    await Promise.all(this.cache.clear().map(disconnect));
  }

  listTypes(): SecretProviderType[] {
    return [...this.types.values()];
  }

  getType(name: string): SecretProviderType | undefined {
    return this.types.get(name);
  }

  /** every connection of the workspace (the workspace routes, `externalSecretsProvider:list` workspace wide) */
  async listConnections(tenantId: string): Promise<SecretConnectionDTO[]> {
    const rows = await this.deps.repos.secrets.list(tenantId);
    return this.toDTOs(tenantId, rows, await this.sharesOf(tenantId, rows));
  }

  async getConnection(tenantId: string, providerKey: string): Promise<SecretConnectionDTO> {
    const row = await this.requireRow(tenantId, providerKey);
    const [dto] = await this.toDTOs(tenantId, [row], await this.sharesOf(tenantId, [row]));
    return dto;
  }

  /**
   * P6-28: the connections a project reaches (n8n's list for a project): its own, the ones shared with
   * it, and the tenant wide ones.
   */
  async listProjectConnections(tenantId: string, projectId: string): Promise<SecretConnectionDTO[]> {
    const rows = await this.deps.repos.secrets.list(tenantId);
    const shares = await this.sharesOf(tenantId, rows);
    const reached = rows.filter((row) => reaches(reachOf(row, shares), projectId));
    return this.toDTOs(tenantId, reached, shares);
  }

  /** P6-28: one connection the project reaches; any other is n8n's 404 */
  async getProjectConnection(
    tenantId: string,
    projectId: string,
    providerKey: string,
  ): Promise<SecretConnectionDTO> {
    const row = await this.requireRow(tenantId, providerKey);
    const shares = await this.sharesOf(tenantId, [row]);
    if (!reaches(reachOf(row, shares), projectId)) throw connectionNotFound(providerKey);
    const [dto] = await this.toDTOs(tenantId, [row], shares);
    return dto;
  }

  /**
   * P6-28: before a change through a project route (n8n's `assertConnectionAccess`): the project must own
   * the connection or have it shared (else 404 "not found in project"), and, unless the caller holds
   * `scope` workspace wide, the project's role on it must hold `scope` (else 403).
   */
  async assertConnectionAccess(
    tenantId: string,
    projectId: string,
    providerKey: string,
    scope: Scope,
    workspaceScopes: ReadonlySet<Scope>,
  ): Promise<void> {
    const { repos } = this.deps;
    const notInProject = () =>
      new ApiError(404, 'not_found', `Connection with key "${providerKey}" not found in project "${projectId}"`);
    const row = await repos.secrets.get(tenantId, providerKey);
    if (!row) throw notInProject();
    const role =
      row.projectId === projectId
        ? OWNER_ROLE
        : (await repos.secrets.accessFor(tenantId, row.id)).find((share) => share.projectId === projectId)?.role;
    if (!role) throw notInProject();
    if (workspaceScopes.has(scope)) return;
    const granted = (RESOURCE_ROLE_SCOPES as Readonly<Record<string, ReadonlySet<Scope>>>)[role];
    if (!granted?.has(scope)) throw ApiError.forbidden(TEXT_LOW_ACCESS);
  }

  /** P6-28: the workspace switch `externalSecrets.systemRolesEnabled` (tenants.settings), off by default */
  async systemRolesEnabled(tenantId: string): Promise<boolean> {
    const tenant = await this.deps.repos.tenants.get(tenantId);
    const settings = (tenant?.settings ?? {}) as { externalSecrets?: { systemRolesEnabled?: unknown } };
    return settings.externalSecrets?.systemRolesEnabled === true;
  }

  /**
   * P6-28: turns the switch on or off (n8n's POST /external-secrets/settings), the other tenant settings
   * kept. `systemRoleAllows` reads it on every call, so nothing is cached to clear.
   */
  async setSystemRolesEnabled(tenantId: string, enabled: boolean, actor?: SecretActor): Promise<boolean> {
    const { repos } = this.deps;
    const settings = ((await repos.tenants.get(tenantId))?.settings ?? {}) as Record<string, unknown>;
    const current = (settings.externalSecrets ?? {}) as Record<string, unknown>;
    await repos.tenants.updateSettings(tenantId, {
      ...settings,
      externalSecrets: { ...current, systemRolesEnabled: enabled },
    });
    await repos.audit.add(tenantId, {
      userId: actor?.userId,
      action: 'tenant.settings_updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { externalSecrets: { systemRolesEnabled: enabled } },
      ip: actor?.ip,
    });
    return this.systemRolesEnabled(tenantId);
  }

  /**
   * P6-28: whether the switch gives `userId` the vault `scope` in `projectId` through its system project
   * role (project admin: every vault scope; project editor: read and list). Read on every call, so a
   * removed member or a switch turned off takes effect at once.
   */
  async systemRoleAllows(tenantId: string, userId: string, projectId: string, scope: Scope): Promise<boolean> {
    if (!isUuid(projectId) || !(await this.systemRolesEnabled(tenantId))) return false;
    const relation = await this.deps.repos.projects.relations.get(tenantId, projectId, userId);
    const role = relation?.role;
    return isSwitchRole(role) && EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES[role].has(scope);
  }

  async createConnection(
    tenantId: string,
    input: SecretConnectionCreateInput,
    actor?: SecretActor,
  ): Promise<SecretConnectionDTO> {
    const { repos } = this.deps;
    this.requireType(input.type);
    if (BLOCKED_KEYS.has(input.providerKey)) {
      throw ApiError.badRequest(`"${input.providerKey}" cannot be used as a connection key`);
    }
    const exists = () => ApiError.badRequest(`Connection with key "${input.providerKey}" already exists`);
    if (await repos.secrets.get(tenantId, input.providerKey)) throw exists();
    // a project's own connection is not shared on create (n8n's project route); a workspace one may be
    const projectId = input.projectId ?? null;
    const shares = projectId ? [] : unique(input.projectIds ?? []);
    await this.requireProjects(tenantId, projectId ? [projectId, ...shares] : shares);
    const id = randomUUID();
    let row: SecretConnectionRow;
    try {
      // the row and its shares together: a connection never exists tenant wide by mistake
      row = await this.inTransaction(async (r) => {
        const created = await r.secrets.create(tenantId, {
          id,
          providerKey: input.providerKey,
          type: input.type,
          settingsEnc: this.encryptSettings(tenantId, id, withoutSentinels(input.settings)),
          isEnabled: input.isEnabled ?? false,
          createdBy: actor?.userId ?? null,
          projectId,
        });
        if (shares.length) await r.secrets.setShares(tenantId, created.id, shares);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw exists();
      throw error;
    }
    await this.audit(tenantId, row, 'created', actor, shares.length ? { projectIds: shares } : {});
    await this.applyRow(row);
    await this.announce(tenantId, row.providerKey);
    return this.getConnection(tenantId, row.providerKey);
  }

  async updateConnection(
    tenantId: string,
    providerKey: string,
    input: SecretConnectionUpdateInput,
    actor?: SecretActor,
  ): Promise<SecretConnectionDTO> {
    const current = await this.requireRow(tenantId, providerKey);
    const typeChanged = input.type !== undefined && input.type !== current.type;
    if (typeChanged && !input.settings) {
      throw ApiError.badRequest('When changing the connection type, new settings must be provided as well');
    }
    if (input.type) this.requireType(input.type);
    // P6-28: the owner project is never a share of its own connection
    const shares =
      input.projectIds === undefined
        ? undefined
        : unique(input.projectIds).filter((projectId) => projectId !== current.projectId);
    if (shares) await this.requireProjects(tenantId, shares);
    let settingsEnc: string | undefined;
    if (input.settings) {
      // stored values never travel to another type; a form that left a field out keeps it
      const stored: SecretProviderSettings = typeChanged ? {} : (this.tryDecrypt(current) ?? {});
      const merged = { ...stored, ...mergeRedacted(stored, input.settings) };
      settingsEnc = this.encryptSettings(tenantId, current.id, withoutSentinels(merged));
    }
    const patch = {
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(settingsEnc !== undefined ? { settingsEnc } : {}),
      ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
    };
    const changed = Object.keys(patch).length > 0;
    if (!changed && shares === undefined) {
      // nothing to change: today's answer, and the provider is read again as before
      await this.audit(tenantId, current, 'updated', actor);
      await this.applyRow(current);
      await this.announce(tenantId, providerKey);
      return this.getConnection(tenantId, providerKey);
    }
    const row = await this.inTransaction(async (r) => {
      const updated = changed ? await r.secrets.update(tenantId, providerKey, patch) : current;
      if (updated && shares) await r.secrets.setShares(tenantId, updated.id, shares);
      return updated;
    });
    if (!row) throw connectionNotFound(providerKey);
    await this.audit(tenantId, row, 'updated', actor, shares ? { projectIds: shares } : {});
    if (!changed) {
      // only the shares moved: the access list changes here and on the other processes, the vault is not read
      await this.loadReach(row);
      await this.announce(tenantId, providerKey, true);
      return this.getConnection(tenantId, providerKey);
    }
    // values read with the old settings are not served under the new ones
    if (settingsEnc !== undefined || typeChanged) await this.forget(tenantId, providerKey);
    if (shares) await this.loadReach(row);
    await this.applyRow(row);
    await this.announce(tenantId, providerKey);
    return this.getConnection(tenantId, providerKey);
  }

  async deleteConnection(tenantId: string, providerKey: string, actor?: SecretActor): Promise<void> {
    const row = await this.requireRow(tenantId, providerKey);
    if (!(await this.deps.repos.secrets.delete(tenantId, providerKey))) throw connectionNotFound(providerKey);
    await this.forget(tenantId, providerKey);
    await this.audit(tenantId, row, 'deleted', actor);
    await this.announce(tenantId, providerKey);
  }

  /** a throwaway provider on the stored settings; the cache stays as it is */
  async testConnection(
    tenantId: string,
    providerKey: string,
    actor?: SecretActor,
  ): Promise<SecretConnectionTestResult> {
    const row = await this.requireRow(tenantId, providerKey);
    const result = await this.runTest(row);
    await this.audit(tenantId, row, 'tested', actor, { success: result.success });
    return result;
  }

  async reloadConnection(
    tenantId: string,
    providerKey: string,
    actor?: SecretActor,
  ): Promise<{ success: boolean }> {
    const row = await this.requireRow(tenantId, providerKey);
    await this.reloadRow(row);
    const live = this.live.get(liveId(tenantId, providerKey));
    const success = row.isEnabled && live?.state === 'connected';
    await this.audit(tenantId, row, 'reloaded', actor, { success });
    await this.announce(tenantId, providerKey);
    return { success };
  }

  /**
   * names only, never values: `{<providerKey>: [secret names]}`. P6-28: the tenant wide connections only
   * (n8n's global completions); a project reads its own through `projectCompletions`.
   */
  async completions(tenantId: string): Promise<Record<string, string[]>> {
    const rows = await this.deps.repos.secrets.list(tenantId);
    const shares = await this.sharesOf(tenantId, rows);
    return this.names(
      tenantId,
      rows.filter((row) => reachOf(row, shares).tenantWide),
    );
  }

  /** P6-28: the secret names of the connections a project owns or has shared (n8n's project completions) */
  async projectCompletions(tenantId: string, projectId: string): Promise<Record<string, string[]>> {
    if (!isUuid(projectId)) return {};
    return this.names(tenantId, await this.deps.repos.secrets.list(tenantId, { projectId }));
  }

  private names(tenantId: string, rows: SecretConnectionRow[]): Record<string, string[]> {
    return Object.fromEntries(
      rows
        .filter((row) => row.isEnabled)
        .map((row) => [row.providerKey, this.cache.names(tenantId, row.providerKey)]),
    );
  }

  /**
   * the `$secrets` object of a tenant, only for reading credential data (resolver.ts). P6-28: `projectId` is
   * the credential's home project; it reads the connections that project owns, the ones shared with it and
   * the tenant wide ones. No project reads the tenant wide ones only. Any other key reads as not reachable.
   */
  secretsFor(tenantId: string, projectId?: string | null): SecretsObject {
    const reader = projectId ?? null;
    return createSecretsProxy(
      this.cache.view(tenantId, (providerKey) => reaches(this.reach.get(liveId(tenantId, providerKey)), reader)),
    );
  }

  /**
   * P6-28: whether a credential of `projectId` may read the vaults `providerKeys` (its `secret_keys`), on save,
   * on test and on a move; throws n8n's 400 naming every key the project cannot reach. A key counts whether
   * its connection is enabled or not; a key with no connection cannot be reached.
   */
  async assertProjectAccess(tenantId: string, projectId: string, providerKeys: string[]): Promise<void> {
    const keys = unique(providerKeys);
    if (!keys.length) return;
    const reachable = new Set(await this.deps.repos.secrets.keysReachableFrom(tenantId, projectId, keys));
    const missing = keys.filter((key) => !reachable.has(key)).sort();
    if (!missing.length) return;
    if (missing.length === 1) {
      throw ApiError.badRequest(`The secret provider "${missing[0]}" does not exist in this project`);
    }
    const list = missing.map((key) => `"${key}"`).join(', ');
    throw ApiError.badRequest(`The secret providers ${list} do not exist in this project`);
  }

  // -----------------------------------------------------------------------------------------
  // rows

  private async requireRow(tenantId: string, providerKey: string): Promise<SecretConnectionRow> {
    const row = await this.deps.repos.secrets.get(tenantId, providerKey);
    if (!row) throw connectionNotFound(providerKey);
    return row;
  }

  /** P6-28: every id must be a project of this workspace (another workspace's id is 404) */
  private async requireProjects(tenantId: string, projectIds: string[]): Promise<void> {
    const found = await Promise.all(
      projectIds.map((id) => (isUuid(id) ? this.deps.repos.projects.get(tenantId, id) : undefined)),
    );
    if (found.some((project) => !project)) throw ApiError.notFound('Project');
  }

  /** the work on one transaction's repositories */
  private async inTransaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.deps.database.db.transaction(async (tx) => work(createRepositories(tx)));
  }

  /** P6-28: the shares of these rows */
  private async sharesOf(tenantId: string, rows: SecretConnectionRow[]): Promise<SecretConnectionShare[]> {
    if (!rows.length) return [];
    return this.deps.repos.secrets.sharesOf(
      tenantId,
      rows.map((row) => row.id),
    );
  }

  private requireType(name: string): SecretProviderType {
    const type = this.types.get(name);
    if (!type) throw ApiError.badRequest(`Unknown provider type "${name}"`);
    return type;
  }

  private binding(tenantId: string, id: string) {
    return { tenantId, credentialId: `secretConnection:${id}` };
  }

  private encryptSettings(tenantId: string, id: string, settings: SecretProviderSettings): string {
    return this.deps.context().cipher.encrypt(settings, this.binding(tenantId, id));
  }

  private tryDecrypt(row: SecretConnectionRow): SecretProviderSettings | undefined {
    try {
      return this.deps
        .context()
        .cipher.decrypt<SecretProviderSettings>(row.settingsEnc, this.binding(row.tenantId, row.id));
    } catch {
      return undefined;
    }
  }

  private async toDTOs(
    tenantId: string,
    rows: SecretConnectionRow[],
    shares: SecretConnectionShare[],
  ): Promise<SecretConnectionDTO[]> {
    const projects = new Map<string, SecretConnectionProject[]>();
    for (const share of shares) {
      const list = projects.get(share.connectionId) ?? [];
      list.push({ ...share.project });
      projects.set(share.connectionId, list);
    }
    return Promise.all(
      rows.filter((row) => row.tenantId === tenantId).map((row) => this.toDTO(row, projects.get(row.id) ?? [])),
    );
  }

  private async toDTO(row: SecretConnectionRow, projects: SecretConnectionProject[]): Promise<SecretConnectionDTO> {
    const live = this.live.get(liveId(row.tenantId, row.providerKey));
    return {
      id: row.id,
      providerKey: row.providerKey,
      type: row.type,
      settings: blankSettings(this.tryDecrypt(row) ?? {}, this.types.get(row.type)),
      isEnabled: row.isEnabled,
      state: live?.state ?? row.state,
      lastError: live ? live.lastError : row.lastError,
      secretsCount: this.cache.names(row.tenantId, row.providerKey).length,
      credentialsCount: await this.deps.repos.secrets.countCredentialsUsing(row.tenantId, row.providerKey),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      projectId: row.projectId ?? null,
      projects,
    };
  }

  private async audit(
    tenantId: string,
    row: SecretConnectionRow,
    action: 'created' | 'updated' | 'deleted' | 'tested' | 'reloaded',
    actor?: SecretActor,
    extra: DataObject = {},
  ): Promise<void> {
    await this.deps.repos.audit.add(tenantId, {
      userId: actor?.userId,
      action: `secret_connection.${action}`,
      resourceType: 'secret_connection',
      resourceId: row.id,
      metadata: {
        providerKey: row.providerKey,
        type: row.type,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...extra,
      },
      ip: actor?.ip,
    });
  }

  // -----------------------------------------------------------------------------------------
  // providers

  private providerDeps(row: SecretConnectionRow): SecretProviderDeps {
    const { config, logger } = this.deps;
    const { connectTimeoutS, refreshTimeoutS, preferGet } = config.externalSecrets;
    return {
      http: this.deps.context().http,
      logger: toWorkflowLogger(logger.child({ tenantId: row.tenantId, providerKey: row.providerKey })),
      connectTimeoutMs: connectTimeoutS * 1000,
      refreshTimeoutMs: refreshTimeoutS * 1000,
      preferGet,
    };
  }

  private connectTimeoutMs(): number {
    return this.deps.config.externalSecrets.connectTimeoutS * 1000;
  }

  private refreshTimeoutMs(): number {
    return this.deps.config.externalSecrets.refreshTimeoutS * 1000;
  }

  /** the row's state on this process: an enabled one connects, anything else is out of the cache */
  private async applyRow(row: SecretConnectionRow): Promise<void> {
    if (row.isEnabled) {
      await this.connect(row);
      return;
    }
    await this.forget(row.tenantId, row.providerKey);
    const state = this.tryDecrypt(row) && this.types.has(row.type) ? 'initialized' : 'error';
    const lastError = state === 'error' ? TEXT_UNREADABLE : null;
    if (row.state !== state || row.lastError !== lastError) {
      await this.persist(row.tenantId, row.providerKey, state, lastError);
    }
  }

  /** take the connection out of this process */
  private async forget(tenantId: string, providerKey: string): Promise<void> {
    const id = liveId(tenantId, providerKey);
    const live = this.live.get(id);
    if (live) {
      live.generation++;
      clearTimeout(live.retry);
      this.live.delete(id);
    }
    this.reach.delete(id);
    await disconnect(this.cache.delete(tenantId, providerKey));
  }

  // -----------------------------------------------------------------------------------------
  // P6-28: the access list

  /** an entry wins only over one read before it */
  private setReach(id: string, entry: ReachEntry): void {
    const current = this.reach.get(id);
    if (!current || current.seq < entry.seq) this.reach.set(id, entry);
  }

  /** read the row's shares again. A failed read closes it to everyone but its owner until the next one. */
  private async loadReach(row: SecretConnectionRow): Promise<void> {
    const seq = ++this.reachSeq;
    const id = liveId(row.tenantId, row.providerKey);
    try {
      const shares = await this.deps.repos.secrets.accessFor(row.tenantId, row.id);
      this.setReach(id, { ...reachOfShares(row, shares.map((share) => share.projectId)), seq });
    } catch (error) {
      this.setReach(id, { projectId: row.projectId ?? null, sharedWith: new Set(), tenantWide: false, seq });
      this.deps.logger.warn(
        { code: pgErrorCode(error), tenantId: row.tenantId, providerKey: row.providerKey },
        'Could not read the projects of an external secret connection',
      );
    }
  }

  /** the timer's rebuild of every enabled connection's entry, from one read */
  private async reloadAllReach(rows: SecretConnectionRow[]): Promise<void> {
    const seq = ++this.reachSeq;
    const shares = await this.deps.repos.secrets.listAllEnabledShares();
    const byConnection = new Map<string, string[]>();
    for (const share of shares) {
      const key = `${share.tenantId}\0${share.connectionId}`;
      byConnection.set(key, [...(byConnection.get(key) ?? []), share.projectId]);
    }
    for (const row of rows) {
      const id = liveId(row.tenantId, row.providerKey);
      if (!this.live.has(id)) continue;
      const sharedWith = byConnection.get(`${row.tenantId}\0${row.id}`) ?? [];
      this.setReach(id, { ...reachOfShares(row, sharedWith), seq });
    }
  }

  /** a new provider from the row. Until it has read the vault, whatever the cache holds keeps answering. */
  private async connect(row: SecretConnectionRow): Promise<void> {
    if (this.stopped) return;
    const id = liveId(row.tenantId, row.providerKey);
    let live = this.live.get(id);
    if (!live) {
      live = {
        tenantId: row.tenantId,
        providerKey: row.providerKey,
        type: row.type,
        version: row.updatedAt.getTime(),
        state: 'initializing',
        lastError: null,
        attempt: 0,
        generation: 0,
      };
      this.live.set(id, live);
    }
    clearTimeout(live.retry);
    live.retry = undefined;
    live.type = row.type;
    live.version = row.updatedAt.getTime();
    const generation = ++live.generation;
    const current = () => this.live.get(id) === live && live.generation === generation;
    const stale = async (provider: SecretProvider) => {
      if (current()) return false;
      await disconnect(provider);
      return true;
    };

    const type = this.types.get(row.type);
    const settings = this.tryDecrypt(row);
    if (!type || !settings) {
      await this.fail(live, type ? TEXT_UNREADABLE : TEXT_UNKNOWN_TYPE);
      return;
    }
    let provider: SecretProvider;
    try {
      provider = type.create(settings, this.providerDeps(row));
      await provider.init();
    } catch (error) {
      if (current()) await this.fail(live, fixedText(error, TEXT_BAD_SETTINGS));
      return;
    }
    if (await stale(provider)) return;
    await this.setState(live, 'connecting', live.lastError);
    try {
      await withTimeout(provider.connect(), this.connectTimeoutMs(), TEXT_TIMEOUT);
      await withTimeout(provider.update(), this.refreshTimeoutMs(), TEXT_TIMEOUT);
    } catch (error) {
      await disconnect(provider);
      if (current())
        await this.failAndRetry(live, fixedText(error, TEXT_CONNECT), () => this.reconnect(live));
      return;
    }
    if (await stale(provider)) return;
    // P6-28: who may read it is known before anyone can
    await this.loadReach(row);
    if (await stale(provider)) return;
    await disconnect(this.cache.set(row.tenantId, row.providerKey, provider));
    live.attempt = 0;
    await this.setState(live, 'connected', null);
  }

  /** read the vault again through the connected provider; on failure the last values stay */
  private async refresh(live: LiveConnection): Promise<void> {
    const provider = this.cache.get(live.tenantId, live.providerKey);
    if (!provider) {
      await this.reconnect(live);
      return;
    }
    const generation = live.generation;
    const current = () =>
      this.live.get(liveId(live.tenantId, live.providerKey)) === live && live.generation === generation;
    try {
      await withTimeout(provider.update(), this.refreshTimeoutMs(), TEXT_TIMEOUT);
    } catch (error) {
      if (current()) await this.failAndRetry(live, fixedText(error, TEXT_REFRESH), () => this.refresh(live));
      return;
    }
    if (!current()) return;
    clearTimeout(live.retry);
    live.retry = undefined;
    live.attempt = 0;
    await this.setState(live, 'connected', null);
  }

  private async reconnect(live: LiveConnection): Promise<void> {
    const row = await this.deps.repos.secrets.get(live.tenantId, live.providerKey);
    if (row?.isEnabled) await this.connect(row);
    else await this.forget(live.tenantId, live.providerKey);
  }

  /** a failure a retry cannot cure */
  private async fail(live: LiveConnection, text: string): Promise<void> {
    this.warn(live, text);
    await this.setState(live, 'error', text);
  }

  /** a failure that may pass: `retrying` until the next attempt */
  private async failAndRetry(live: LiveConnection, text: string, again: () => Promise<void>): Promise<void> {
    this.warn(live, text);
    await this.setState(live, 'retrying', text);
    clearTimeout(live.retry);
    live.retry = setTimeout(
      () => {
        live.retry = undefined;
        again().catch(() => this.warn(live, TEXT_CONNECT));
      },
      backoffDelayMs(live.attempt++),
    );
    live.retry.unref();
  }

  /** names and fixed texts only, never the error of a provider */
  private warn(live: LiveConnection, text: string): void {
    this.deps.logger.warn(
      { tenantId: live.tenantId, providerKey: live.providerKey, type: live.type, reason: text },
      'External secret connection failed',
    );
  }

  private async setState(
    live: LiveConnection,
    state: SecretProviderState,
    lastError: string | null,
  ): Promise<void> {
    if (live.state === state && live.lastError === lastError) return;
    live.state = state;
    live.lastError = lastError;
    if (this.live.get(liveId(live.tenantId, live.providerKey)) === live) {
      await this.persist(live.tenantId, live.providerKey, state, lastError);
    }
  }

  private async persist(
    tenantId: string,
    providerKey: string,
    state: SecretProviderState,
    lastError: string | null,
  ): Promise<void> {
    await this.deps.repos.secrets.update(tenantId, providerKey, { state, lastError }).catch(() => {});
  }

  private async runTest(row: SecretConnectionRow): Promise<SecretConnectionTestResult> {
    const type = this.types.get(row.type);
    const settings = this.tryDecrypt(row);
    if (!type) return { success: false, testState: 'error', error: TEXT_UNKNOWN_TYPE };
    if (!settings) return { success: false, testState: 'error', error: TEXT_UNREADABLE };
    let provider: SecretProvider | undefined;
    try {
      provider = type.create(settings, this.providerDeps(row));
      await provider.init();
      await withTimeout(provider.connect(), this.connectTimeoutMs(), TEXT_TIMEOUT);
      const result = await withTimeout(provider.test(), this.connectTimeoutMs(), TEXT_TIMEOUT);
      if (!result.success) {
        return { success: false, testState: 'error', error: (result.error ?? TEXT_TEST).slice(0, 300) };
      }
      return { success: true, testState: row.isEnabled ? 'connected' : 'tested' };
    } catch (error) {
      return { success: false, testState: 'error', error: fixedText(error, TEXT_TEST) };
    } finally {
      await disconnect(provider);
    }
  }

  // -----------------------------------------------------------------------------------------
  // this process and the others

  private async mapLimit<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const runner = async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
  }

  private async loadEnabled(): Promise<void> {
    const run = this.loadRun;
    const rows = await this.deps.repos.secrets.listAllEnabled();
    await this.mapLimit(rows, async (row) => {
      if (run === this.loadRun) await this.connect(row);
    });
  }

  /**
   * What the timer does: pick up rows this process missed (a bus message can get lost), drop rows that
   * are gone, and read every vault again.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = await this.deps.repos.secrets.listAllEnabled();
      const enabled = new Set(rows.map((row) => liveId(row.tenantId, row.providerKey)));
      for (const live of [...this.live.values()]) {
        if (!enabled.has(liveId(live.tenantId, live.providerKey))) {
          await this.forget(live.tenantId, live.providerKey);
        }
      }
      // P6-28: a share change whose bus message got lost is picked up here
      await this.reloadAllReach(rows);
      await this.mapLimit(rows, async (row) => {
        const live = this.live.get(liveId(row.tenantId, row.providerKey));
        if (!live || live.version !== row.updatedAt.getTime()) {
          // a row with new settings: the values read with the old ones go first
          if (live) await this.forget(row.tenantId, row.providerKey);
          await this.connect(row);
        } else if (!live.retry && this.cache.get(row.tenantId, row.providerKey)) {
          await this.refresh(live);
        }
      });
    } catch (error) {
      this.deps.logger.warn(
        { code: pgErrorCode(error) },
        'Could not refresh the external secret connections',
      );
    } finally {
      this.ticking = false;
    }
  }

  /** a reload of the row on this process */
  private async reloadRow(row: SecretConnectionRow): Promise<void> {
    if (!row.isEnabled) {
      await this.forget(row.tenantId, row.providerKey);
      return;
    }
    const live = this.live.get(liveId(row.tenantId, row.providerKey));
    if (live && live.version === row.updatedAt.getTime() && this.cache.get(row.tenantId, row.providerKey)) {
      await this.refresh(live);
      return;
    }
    // the row changed: the values read with the old settings go first
    if (live) await this.forget(row.tenantId, row.providerKey);
    await this.connect(row);
  }

  /** `accessOnly`: only the projects that reach it changed (P6-28), the vault is not read again */
  private async announce(tenantId: string, providerKey: string, accessOnly = false): Promise<void> {
    await this.deps
      .context()
      .bus.publish(RELOAD_CHANNEL, {
        tenantId,
        providerKey,
        origin: this.instanceId,
        ...(accessOnly ? { accessOnly: true } : {}),
      })
      .catch(() => {});
  }

  private async onReloadMessage(message: unknown): Promise<void> {
    const { tenantId, providerKey, origin, accessOnly } = (message ?? {}) as Record<string, unknown>;
    if (typeof tenantId !== 'string' || typeof providerKey !== 'string') return;
    if (origin === this.instanceId || !this.running) return;
    try {
      const row = await this.deps.repos.secrets.get(tenantId, providerKey);
      if (!row) {
        await this.forget(tenantId, providerKey);
        return;
      }
      // P6-28: the access list first, so a narrowed share holds before the vault is read again
      if (row.isEnabled) await this.loadReach(row);
      if (accessOnly !== true) await this.reloadRow(row);
    } catch (error) {
      this.deps.logger.warn(
        { code: pgErrorCode(error), tenantId, providerKey },
        'Could not reload an external secret connection',
      );
    }
  }
}

const connectionNotFound = (providerKey: string) => ApiError.notFound(`Connection with key "${providerKey}"`);

const unique = (values: string[]): string[] => [...new Set(values)];

/** P6-28: a row's reach from the projects it is shared with */
function reachOfShares(row: SecretConnectionRow, sharedWith: string[]): SecretConnectionReach {
  const projectId = row.projectId ?? null;
  return { projectId, sharedWith: new Set(sharedWith), tenantWide: projectId === null && sharedWith.length === 0 };
}

/** P6-28: a row's reach from the shares of a listing */
function reachOf(row: SecretConnectionRow, shares: SecretConnectionShare[]): SecretConnectionReach {
  return reachOfShares(
    row,
    shares.filter((share) => share.connectionId === row.id).map((share) => share.project.id),
  );
}

/**
 * P6-28: whether a read under `projectId` (null: no project) may use the connection; no entry is no.
 * Tenant wide: everyone. Otherwise only the owning project and the projects it is shared with.
 */
function reaches(reach: SecretConnectionReach | undefined, projectId: string | null): boolean {
  if (!reach) return false;
  if (reach.tenantWide) return true;
  if (projectId === null) return false;
  return reach.projectId === projectId || reach.sharedWith.has(projectId);
}

function withoutSentinels(settings: SecretProviderSettings): SecretProviderSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== REDACTED));
}

/**
 * Settings as the API shows them. Only a field the type declares as not secret is shown: a password,
 * a left-over field and everything of an unknown type are blanked. An empty value stays empty, so the
 * form can tell it is not set.
 */
function blankSettings(
  settings: SecretProviderSettings,
  type: SecretProviderType | undefined,
): SecretProviderSettings {
  const visible = new Set(
    (type?.properties ?? []).filter((p) => !p.typeOptions?.password).map((p) => p.name),
  );
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      visible.has(key) || value === '' || value === null || value === undefined ? value : REDACTED,
    ]),
  );
}
