/**
 * External secrets manager (P4-07): the registry of provider types, the per-tenant connections and
 * the cache of live providers on every main and worker process. The cache is loaded before jobs start,
 * refreshed on a timer, and a change on one instance reaches the others on the bus. Secret values stay
 * inside the providers: logs, errors, audit rows and the bus carry names and fixed texts only.
 */
import { randomUUID } from 'node:crypto';
import { mergeRedacted, REDACTED } from '@workflow/core';
import { BLOCKED_KEYS, type DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { SecretConnectionRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { toWorkflowLogger } from '../../logger';
import { isUniqueViolation, pgErrorCode } from '../../repositories';
import { SecretsCache } from './cache';
import { SECRET_PROVIDER_TYPES } from './providers';
import { createSecretsProxy, type SecretsObject } from './proxy';
import { backoffDelayMs, TimeoutError, withTimeout } from './retry';
import type {
  SecretActor,
  SecretConnectionCreateInput,
  SecretConnectionDTO,
  SecretConnectionTestResult,
  SecretConnectionUpdateInput,
  SecretProvider,
  SecretProviderDeps,
  SecretProviderSettings,
  SecretProviderState,
  SecretProviderType,
} from './types';

const RELOAD_CHANNEL = 'secrets:reload';
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
    await Promise.all(this.cache.clear().map(disconnect));
  }

  listTypes(): SecretProviderType[] {
    return [...this.types.values()];
  }

  getType(name: string): SecretProviderType | undefined {
    return this.types.get(name);
  }

  async listConnections(tenantId: string): Promise<SecretConnectionDTO[]> {
    const rows = await this.deps.repos.secrets.list(tenantId);
    return Promise.all(rows.map((row) => this.toDTO(row)));
  }

  async getConnection(tenantId: string, providerKey: string): Promise<SecretConnectionDTO> {
    return this.toDTO(await this.requireRow(tenantId, providerKey));
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
    const id = randomUUID();
    let row: SecretConnectionRow;
    try {
      row = await repos.secrets.create(tenantId, {
        id,
        providerKey: input.providerKey,
        type: input.type,
        settingsEnc: this.encryptSettings(tenantId, id, withoutSentinels(input.settings)),
        isEnabled: input.isEnabled ?? false,
        createdBy: actor?.userId ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw exists();
      throw error;
    }
    await this.audit(tenantId, row, 'created', actor);
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
    const { repos } = this.deps;
    const current = await this.requireRow(tenantId, providerKey);
    const typeChanged = input.type !== undefined && input.type !== current.type;
    if (typeChanged && !input.settings) {
      throw ApiError.badRequest('When changing the connection type, new settings must be provided as well');
    }
    if (input.type) this.requireType(input.type);
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
    const row = Object.keys(patch).length
      ? await repos.secrets.update(tenantId, providerKey, patch)
      : current;
    if (!row) throw connectionNotFound(providerKey);
    await this.audit(tenantId, row, 'updated', actor);
    // values read with the old settings are not served under the new ones
    if (settingsEnc !== undefined || typeChanged) await this.forget(tenantId, providerKey);
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

  /** names only, never values: `{<providerKey>: [secret names]}` */
  async completions(tenantId: string): Promise<Record<string, string[]>> {
    const rows = await this.deps.repos.secrets.list(tenantId);
    return Object.fromEntries(
      rows
        .filter((row) => row.isEnabled)
        .map((row) => [row.providerKey, this.cache.names(tenantId, row.providerKey)]),
    );
  }

  /**
   * the `$secrets` object of a tenant, only for reading credential data (resolver.ts). P6 S1: `projectId` is
   * the credential's project; until L8 every connection of the tenant stays readable.
   */
  secretsFor(tenantId: string, projectId?: string | null): SecretsObject {
    // stub (L8): every connection of the tenant stays readable
    void projectId;
    return createSecretsProxy(this.cache.view(tenantId));
  }

  /**
   * P6 S1: whether a credential of `projectId` may read the vaults `providerKeys` (its `secret_keys`), on save
   * and on test; throws when one is not open to the project. Passes until L8 fills it.
   */
  async assertProjectAccess(tenantId: string, projectId: string, providerKeys: string[]): Promise<void> {
    // stub (L8): passes everything until L8 reads project_secret_access (P6-35)
    void tenantId;
    void projectId;
    void providerKeys;
  }

  // -----------------------------------------------------------------------------------------
  // rows

  private async requireRow(tenantId: string, providerKey: string): Promise<SecretConnectionRow> {
    const row = await this.deps.repos.secrets.get(tenantId, providerKey);
    if (!row) throw connectionNotFound(providerKey);
    return row;
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

  private async toDTO(row: SecretConnectionRow): Promise<SecretConnectionDTO> {
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
      metadata: { providerKey: row.providerKey, type: row.type, ...extra },
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
    await disconnect(this.cache.delete(tenantId, providerKey));
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

  private async announce(tenantId: string, providerKey: string): Promise<void> {
    await this.deps
      .context()
      .bus.publish(RELOAD_CHANNEL, { tenantId, providerKey, origin: this.instanceId })
      .catch(() => {});
  }

  private async onReloadMessage(message: unknown): Promise<void> {
    const { tenantId, providerKey, origin } = (message ?? {}) as Record<string, unknown>;
    if (typeof tenantId !== 'string' || typeof providerKey !== 'string') return;
    if (origin === this.instanceId || !this.running) return;
    try {
      const row = await this.deps.repos.secrets.get(tenantId, providerKey);
      if (row) await this.reloadRow(row);
      else await this.forget(tenantId, providerKey);
    } catch (error) {
      this.deps.logger.warn(
        { code: pgErrorCode(error), tenantId, providerKey },
        'Could not reload an external secret connection',
      );
    }
  }
}

const connectionNotFound = (providerKey: string) => ApiError.notFound(`Connection with key "${providerKey}"`);

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
