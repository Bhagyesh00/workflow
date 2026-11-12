/**
 * P6-06 (S5 L3): one `LogStreamingManager` per process. It loads a tenant's destinations on that tenant's first
 * event (and keeps a negative cache when there are none), reloads on bus channel `log-destinations:reload`
 * `{ tenantId }`, keeps one bounded queue (2000 events and 16 MB, the oldest dropped and counted), one breaker and
 * one sender loop per destination, and answers the REST and public routes (`/eventbus/*`,
 * `/settings/log-streaming/*`).
 *
 * `sink.accepts` is true only when an enabled destination of the tenant subscribes to the event, so a payload is
 * built only then; until a tenant's destinations are loaded it says yes and holds the events, so none is lost.
 * A failed send or an open breaker hands the event to `FailedEventStore`; a closing breaker and every reload ask it
 * to replay. A destination's secrets live encrypted in `secrets_enc` (binding `logDestination:<id>`) and are blank
 * in every answer. Destinations are per tenant: an event of one tenant never reaches another tenant's destination.
 */
import { randomUUID } from 'node:crypto';
import {
  type CircuitBreakerSettings,
  DEFAULT_CIRCUIT_BREAKER,
  DESTINATION_TEST_EVENT,
  EVENT_CATALOG,
  type LogDestination,
  type LogDestinationTestResult,
  type LogDestinationType,
  matchesSubscription,
  redactSecrets,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { LogDestinationRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { pgErrorCode } from '../../repositories/util';
import type { EventSink, StreamEvent } from '../events/stream';
import { anonymizeAuditPayload } from './anonymize';
import { CircuitBreaker } from './breaker';
import { assertDestinationCredential } from './credential-check';
import { createSentrySender, validateSentrySettings } from './destinations/sentry';
import { createSyslogSender, validateSyslogSettings } from './destinations/syslog';
import { createWebhookSender, validateWebhookSettings } from './destinations/webhook';
import { FailedEventStore } from './failed-store';
import {
  blankSecretKeys,
  destinationEndpoint,
  destinationSecretBinding,
  mergeDestinationSecrets,
  splitDestinationSecrets,
} from './secrets';
import type { DestinationSender, DestinationTypeEntry, SenderDeps, StoredDestination } from './types';

const RELOAD_CHANNEL = 'log-destinations:reload';
/** per destination: the queue holds at most this many events and this many bytes of serialized events */
const MAX_QUEUE_EVENTS = 2000;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
/** events held for a tenant whose destinations are still loading */
const MAX_PENDING_EVENTS = 2000;
const LAST_ERROR_MAX = 1000;
/** how long `close` waits for the queues to drain */
const CLOSE_WAIT_MS = 3000;
/** n8n's default subscriptions, less the `n8n.` prefix */
const DEFAULT_SUBSCRIPTIONS = Object.freeze(['audit', 'workflow']);
const DEFAULT_LABEL = 'Log Destination';
const ENDPOINT_CHANGED = "Couldn't keep the saved secret values: the endpoint changed. Re-enter them.";

/** a save: no id creates, an id updates; `settings` passes the type's `validate` (else 400 with its text) */
export interface LogDestinationInput {
  id?: string;
  type: LogDestinationType;
  label?: string;
  enabled?: boolean;
  subscribedEvents?: string[];
  anonymizeAuditMessages?: boolean;
  credentialId?: string | null;
  circuitBreaker?: CircuitBreakerSettings;
  settings?: unknown;
}

interface Queued {
  event: StreamEvent;
  size: number;
}

/** what the process keeps per enabled destination */
interface Runtime {
  row: LogDestinationRow;
  sender: DestinationSender;
  /** senders replaced by a reload, closed once the loop is idle */
  retired: DestinationSender[];
  breaker: CircuitBreaker;
  queue: Queued[];
  bytes: number;
  dropped: number;
  draining: boolean;
  loop: Promise<void> | null;
  replayWanted: boolean;
  errored: boolean;
  disposed: boolean;
  /** the secret values, to scrub them out of an error text */
  secretValues: string[];
  /** what a rebuild of the sender depends on */
  signature: string;
}

interface TenantState {
  runtimes: Map<string, Runtime>;
  loaded: boolean;
  loading: Promise<void> | null;
  again: boolean;
  /** events that arrived before the tenant's destinations were loaded */
  pending: StreamEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** the error text a client or the store may see: scrubbed, redacted, cut, no stack */
function errorText(error: unknown, secretValues: string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Send failed';
  for (const value of secretValues) text = text.split(value).join('[redacted]');
  return redactSecrets(text).slice(0, LAST_ERROR_MAX);
}

export class LogStreamingManager {
  /** the event stream's sink: accepts only events an enabled destination of the tenant subscribes to */
  readonly sink: EventSink;
  /** the registered destination types */
  protected readonly types = new Map<LogDestinationType, DestinationTypeEntry>();

  private readonly tenants = new Map<string, TenantState>();
  private readonly instanceId = randomUUID();
  private subscription: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private failedStore: FailedEventStore | null = null;

  constructor(readonly deps: ServiceDeps) {
    this.registerType('webhook', { create: createWebhookSender, validate: validateWebhookSettings });
    this.registerType('syslog', { create: createSyslogSender, validate: validateSyslogSettings });
    this.registerType('sentry', { create: createSentrySender, validate: validateSentrySettings });
    this.sink = {
      accepts: (tenantId, eventName) => this.accepts(tenantId, eventName),
      deliver: (event) => this.deliver(event),
    };
  }

  /** a later call for the same type replaces the entry (tests register a fake sender type this way) */
  registerType(type: LogDestinationType, entry: DestinationTypeEntry): void {
    this.types.set(type, entry);
  }

  /** the event names (catalog) a destination may subscribe to */
  eventNames(): string[] {
    return EVENT_CATALOG.map((entry) => entry.name);
  }

  // ---------------------------------------------------------------------------------------------
  // the routes' side

  /** the workspace's destinations, secrets blank */
  async list(auth: AuthContext): Promise<LogDestination[]> {
    const tenantId = auth.tenant.id;
    const rows = await this.deps.repos.logDestinations.list(tenantId);
    return rows.map((row) => this.toDto(row));
  }

  /** one destination of the workspace, secrets blank; another tenant's id is 404 */
  async get(auth: AuthContext, id: string): Promise<LogDestination> {
    const row = await this.deps.repos.logDestinations.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Log destination');
    return this.toDto(row);
  }

  /** creates or updates a destination and reloads it on every process */
  async save(auth: AuthContext, input: LogDestinationInput): Promise<LogDestination> {
    const tenantId = auth.tenant.id;
    const repo = this.deps.repos.logDestinations;
    const existing = input.id ? await repo.get(tenantId, input.id) : undefined;
    if (input.id && !existing) throw ApiError.notFound('Log destination');
    if (existing && input.type !== existing.type) {
      throw ApiError.badRequest("Couldn't change the type of a destination. Create a new one instead.");
    }
    const entry = this.types.get(input.type);
    if (!entry) throw ApiError.badRequest(`Unknown destination type "${String(input.type)}"`);

    const label = this.checkLabel(input.label ?? existing?.label ?? DEFAULT_LABEL);
    const subscribedEvents = this.checkEvents(
      input.subscribedEvents ?? existing?.subscribedEvents ?? [...DEFAULT_SUBSCRIPTIONS],
    );
    const circuitBreaker = this.checkBreaker(input.circuitBreaker ?? existing?.circuitBreaker ?? null);
    const credentialId =
      input.credentialId !== undefined ? input.credentialId : (existing?.credentialId ?? null);
    if (credentialId) {
      if (input.type !== 'webhook') {
        throw ApiError.badRequest("Couldn't use a credential: only a webhook destination takes one.");
      }
      if (credentialId !== existing?.credentialId) {
        await assertDestinationCredential(this.deps, auth, credentialId);
      }
    }

    const id = existing?.id ?? randomUUID();
    const stored = this.storeSettings(tenantId, id, input.type, entry, input.settings, existing);
    const values = {
      type: input.type,
      label,
      enabled: input.enabled ?? existing?.enabled ?? false,
      subscribedEvents,
      anonymizeAuditMessages: input.anonymizeAuditMessages ?? existing?.anonymizeAuditMessages ?? false,
      circuitBreaker,
      credentialId,
      ...stored,
    };
    const row = existing
      ? await repo.save(tenantId, existing.id, values)
      : await repo.create(tenantId, id, { ...values, createdBy: auth.user.id });
    await this.announce(tenantId);
    return this.toDto(row);
  }

  /** deletes a destination (its failed events go with it) */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const tenantId = auth.tenant.id;
    if (!(await this.deps.repos.logDestinations.delete(tenantId, id))) {
      throw ApiError.notFound('Log destination');
    }
    await this.announce(tenantId);
  }

  /** sends `destination.test` past the breaker; the error text is redacted */
  async test(auth: AuthContext, id: string): Promise<LogDestinationTestResult> {
    const tenantId = auth.tenant.id;
    const repo = this.deps.repos.logDestinations;
    const row = await repo.get(tenantId, id);
    if (!row) throw ApiError.notFound('Log destination');
    const entry = this.types.get(row.type);
    if (!entry) return { success: false, error: `Unknown destination type "${row.type}"` };
    let sender: DestinationSender | undefined;
    let secretValues: string[] = [];
    try {
      const built = this.build(row, entry);
      sender = built.sender;
      secretValues = built.secretValues;
      await sender.send(
        {
          id: randomUUID(),
          ts: new Date().toISOString(),
          eventName: DESTINATION_TEST_EVENT,
          message: DESTINATION_TEST_EVENT,
          payload: {},
          tenantId,
        },
        { test: true },
      );
      await repo.setLastError(tenantId, id, null);
      return { success: true };
    } catch (error) {
      const text = errorText(error, secretValues);
      await repo.setLastError(tenantId, id, text).catch(() => {});
      return { success: false, error: text };
    } finally {
      await sender?.close?.().catch(() => {});
    }
  }

  /** drains the queues and closes the senders (called by the context's `close`) */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  // ---------------------------------------------------------------------------------------------
  // the stream's side

  private accepts(tenantId: string, eventName: string): boolean {
    if (this.closed) return false;
    const state = this.tenants.get(tenantId);
    if (!state || !state.loaded) {
      if (!state?.loading) void this.load(tenantId);
      return true;
    }
    for (const runtime of state.runtimes.values()) {
      if (matchesSubscription(eventName, runtime.row.subscribedEvents)) return true;
    }
    return false;
  }

  private deliver(event: StreamEvent): void {
    if (this.closed) return;
    const state = this.tenants.get(event.tenantId);
    if (!state?.loaded) {
      const target = state ?? this.stateOf(event.tenantId);
      target.pending.push(event);
      if (target.pending.length > MAX_PENDING_EVENTS) target.pending.shift();
      if (!target.loading) void this.load(event.tenantId);
      return;
    }
    this.route(state, event);
  }

  private route(state: TenantState, event: StreamEvent): void {
    for (const runtime of state.runtimes.values()) {
      if (matchesSubscription(event.eventName, runtime.row.subscribedEvents)) this.enqueue(runtime, event);
    }
  }

  private enqueue(runtime: Runtime, event: StreamEvent): void {
    let delivered = event;
    let size: number;
    try {
      if (runtime.row.anonymizeAuditMessages) {
        delivered = { ...event, payload: anonymizeAuditPayload(event.eventName, event.payload) };
      }
      size = Buffer.byteLength(JSON.stringify(delivered));
    } catch {
      runtime.dropped += 1;
      return;
    }
    if (size > MAX_QUEUE_BYTES) {
      runtime.dropped += 1;
      return;
    }
    while (
      runtime.queue.length > 0 &&
      (runtime.queue.length >= MAX_QUEUE_EVENTS || runtime.bytes + size > MAX_QUEUE_BYTES)
    ) {
      const oldest = runtime.queue.shift() as Queued;
      runtime.bytes -= oldest.size;
      runtime.dropped += 1;
    }
    runtime.queue.push({ event: delivered, size });
    runtime.bytes += size;
    this.kick(runtime);
  }

  // ---------------------------------------------------------------------------------------------
  // the sender loop of one destination

  private kick(runtime: Runtime): void {
    if (runtime.draining || runtime.disposed) return;
    runtime.draining = true;
    runtime.loop = this.drain(runtime);
  }

  private async drain(runtime: Runtime): Promise<void> {
    try {
      if (runtime.replayWanted) {
        runtime.replayWanted = false;
        await this.replay(runtime);
      }
      while (!runtime.disposed) {
        const item = runtime.queue.shift();
        if (!item) break;
        runtime.bytes -= item.size;
        await this.sendOne(runtime, item.event);
      }
    } catch (error) {
      this.deps.logger.warn(
        { code: pgErrorCode(error), destinationId: runtime.row.id },
        'A log destination loop failed',
      );
    } finally {
      runtime.draining = false;
      this.closeRetired(runtime);
      // a reload asked for a replay while the loop was busy
      if (!runtime.disposed && runtime.replayWanted) this.kick(runtime);
    }
  }

  private async sendOne(runtime: Runtime, event: StreamEvent): Promise<void> {
    const { tenantId, id } = runtime.row;
    const wasHalfOpen = runtime.breaker.state === 'half-open';
    if (!runtime.breaker.canSend()) {
      await this.keep(runtime, event, 'The circuit breaker is open');
      return;
    }
    try {
      await runtime.sender.send(event, {});
    } catch (error) {
      runtime.breaker.recordFailure();
      const text = errorText(error, runtime.secretValues);
      runtime.errored = true;
      await this.deps.repos.logDestinations.setLastError(tenantId, id, text).catch(() => {});
      await this.keep(runtime, event, text);
      return;
    }
    runtime.breaker.recordSuccess();
    if (runtime.errored) {
      runtime.errored = false;
      await this.deps.repos.logDestinations.setLastError(tenantId, id, null).catch(() => {});
    }
    if (wasHalfOpen && runtime.breaker.state === 'closed') await this.replay(runtime);
  }

  private async keep(runtime: Runtime, event: StreamEvent, error: string): Promise<void> {
    try {
      await this.store().add(runtime.row.tenantId, runtime.row.id, event, error);
    } catch (failure) {
      this.deps.logger.warn(
        { code: pgErrorCode(failure), destinationId: runtime.row.id },
        'Could not keep a failed log event',
      );
    }
  }

  private async replay(runtime: Runtime): Promise<void> {
    if (runtime.breaker.state === 'open') return;
    try {
      await this.store().replay(runtime.row.tenantId, runtime.row.id, async (event) => {
        if (!runtime.breaker.canSend()) throw new Error('The circuit breaker is open');
        try {
          await runtime.sender.send(event, {});
        } catch (error) {
          runtime.breaker.recordFailure();
          throw error;
        }
        runtime.breaker.recordSuccess();
      });
    } catch (error) {
      this.deps.logger.warn(
        { code: pgErrorCode(error), destinationId: runtime.row.id },
        'Could not replay the failed log events',
      );
    }
  }

  private store(): FailedEventStore {
    this.failedStore ??= new FailedEventStore(this.deps);
    return this.failedStore;
  }

  private closeRetired(runtime: Runtime): void {
    for (const sender of runtime.retired.splice(0)) void sender.close?.().catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------
  // loading a tenant's destinations

  private stateOf(tenantId: string): TenantState {
    let state = this.tenants.get(tenantId);
    if (!state) {
      state = { runtimes: new Map(), loaded: false, loading: null, again: false, pending: [] };
      this.tenants.set(tenantId, state);
    }
    return state;
  }

  /** (re)reads the tenant's destinations; a call while one runs makes it run once more. Never rejects. */
  private load(tenantId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const state = this.stateOf(tenantId);
    if (state.loading) {
      state.again = true;
      return state.loading;
    }
    const run = async () => {
      try {
        await this.ensureSubscribed();
        do {
          state.again = false;
          await this.refresh(tenantId, state);
          state.loaded = true;
        } while (state.again && !this.closed);
        for (const event of state.pending.splice(0)) this.route(state, event);
      } catch (error) {
        this.deps.logger.warn({ code: pgErrorCode(error) }, 'Could not load the log destinations');
      } finally {
        state.loading = null;
      }
    };
    state.loading = run();
    return state.loading;
  }

  private async refresh(tenantId: string, state: TenantState): Promise<void> {
    const rows = await this.deps.repos.logDestinations.list(tenantId);
    if (this.closed) return;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.enabled) continue;
      const entry = this.types.get(row.type);
      if (!entry) continue;
      seen.add(row.id);
      const existing = state.runtimes.get(row.id);
      if (existing && existing.signature === this.signatureOf(row)) {
        existing.row = row;
        existing.replayWanted = true;
        this.kick(existing);
        continue;
      }
      let built: ReturnType<LogStreamingManager['build']>;
      try {
        built = this.build(row, entry);
      } catch (error) {
        this.deps.logger.warn(
          { code: pgErrorCode(error), destinationId: row.id },
          'Could not start a log destination',
        );
        continue;
      }
      if (existing) {
        existing.retired.push(existing.sender);
        existing.sender = built.sender;
        existing.row = row;
        existing.secretValues = built.secretValues;
        existing.signature = this.signatureOf(row);
        existing.breaker = new CircuitBreaker(row.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER, () =>
          Date.now(),
        );
        existing.replayWanted = true;
        if (existing.draining) continue;
        this.closeRetired(existing);
        this.kick(existing);
        continue;
      }
      const runtime: Runtime = {
        row,
        sender: built.sender,
        retired: [],
        breaker: new CircuitBreaker(row.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER, () => Date.now()),
        queue: [],
        bytes: 0,
        dropped: 0,
        draining: false,
        loop: null,
        replayWanted: true,
        errored: row.lastError !== null,
        disposed: false,
        secretValues: built.secretValues,
        signature: this.signatureOf(row),
      };
      state.runtimes.set(row.id, runtime);
      this.kick(runtime);
    }
    for (const [id, runtime] of [...state.runtimes]) {
      if (!seen.has(id)) {
        state.runtimes.delete(id);
        this.dispose(runtime);
      }
    }
  }

  private signatureOf(row: LogDestinationRow): string {
    return JSON.stringify([row.type, row.settings, row.secretsEnc, row.credentialId, row.circuitBreaker]);
  }

  private dispose(runtime: Runtime): void {
    runtime.disposed = true;
    runtime.queue = [];
    runtime.bytes = 0;
    const senders = [runtime.sender, ...runtime.retired.splice(0)];
    for (const sender of senders) void sender.close?.().catch(() => {});
  }

  /** the sender of a stored destination, with its decrypted secrets merged back (never logged, never returned) */
  private build(row: LogDestinationRow, entry: DestinationTypeEntry) {
    const ctx = this.deps.context();
    let settings: Record<string, unknown> = row.settings;
    let secretValues: string[] = [];
    if (row.secretsEnc) {
      const secrets = ctx.cipher.decrypt<Record<string, string>>(
        row.secretsEnc,
        destinationSecretBinding(row.tenantId, row.id),
      );
      settings = mergeDestinationSecrets(row.type, settings, secrets);
      secretValues = Object.values(secrets).filter((value) => value.length >= 4);
    }
    const { secretsEnc: _secrets, ...rest } = row;
    const stored = { ...rest, settings } as unknown as StoredDestination;
    const senderDeps: SenderDeps = {
      http: ctx.http,
      credentials: ctx.credentials,
      cipher: ctx.cipher,
      config: ctx.config,
      logger: ctx.logger,
    };
    return { sender: entry.create(senderDeps, stored), secretValues };
  }

  // ---------------------------------------------------------------------------------------------
  // several processes

  private ensureSubscribed(): Promise<void> {
    if (!this.subscription) {
      this.subscription = this.deps
        .context()
        .bus.subscribe(RELOAD_CHANNEL, (message) => this.onReload(message))
        .then((unsubscribe) => {
          if (this.closed) unsubscribe();
          else this.unsubscribe = unsubscribe;
        })
        .catch((error) => {
          this.subscription = null;
          this.deps.logger.warn(
            { code: pgErrorCode(error) },
            'Could not subscribe to log destination reloads',
          );
        });
    }
    return this.subscription;
  }

  private onReload(message: unknown): void {
    if (!isRecord(message) || typeof message.tenantId !== 'string') return;
    if (message.origin === this.instanceId || this.closed) return;
    if (this.tenants.has(message.tenantId)) void this.load(message.tenantId);
  }

  /** reloads this process now and tells the others */
  private async announce(tenantId: string): Promise<void> {
    await this.load(tenantId);
    await this.deps
      .context()
      .bus.publish(RELOAD_CHANNEL, { tenantId, origin: this.instanceId })
      .catch(() => {});
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const runtimes = [...this.tenants.values()].flatMap((state) => [...state.runtimes.values()]);
    const loops = runtimes
      .map((runtime) => runtime.loop)
      .filter((loop): loop is Promise<void> => loop !== null);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(loops),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const runtime of runtimes) this.dispose(runtime);
    this.tenants.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // checks and mapping

  private toDto(row: LogDestinationRow): LogDestination {
    const dropped = this.tenants.get(row.tenantId)?.runtimes.get(row.id)?.dropped ?? 0;
    return {
      id: row.id,
      type: row.type,
      label: row.label,
      enabled: row.enabled,
      subscribedEvents: row.subscribedEvents,
      anonymizeAuditMessages: row.anonymizeAuditMessages,
      credentialId: row.credentialId,
      circuitBreaker: row.circuitBreaker ?? { ...DEFAULT_CIRCUIT_BREAKER },
      settings: splitDestinationSecrets(row.type, row.settings).settings,
      lastError: row.lastError,
      droppedEvents: dropped,
    } as unknown as LogDestination;
  }

  private checkLabel(label: unknown): string {
    const text = typeof label === 'string' ? label.trim() : '';
    if (text.length < 1 || text.length > 255) {
      throw ApiError.badRequest('The label must be 1 to 255 characters');
    }
    return text;
  }

  private checkEvents(events: unknown): string[] {
    if (!Array.isArray(events) || events.length > 500) {
      throw ApiError.badRequest("Couldn't read the subscribed events");
    }
    const names = EVENT_CATALOG.map((entry) => entry.name);
    for (const entry of events) {
      const known =
        typeof entry === 'string' &&
        (entry === '*' || names.some((name) => name === entry || name.startsWith(`${entry}.`)));
      if (!known) {
        throw ApiError.badRequest(`Unknown event "${typeof entry === 'string' ? entry.slice(0, 100) : '?'}"`);
      }
    }
    return events as string[];
  }

  private checkBreaker(breaker: CircuitBreakerSettings | null): CircuitBreakerSettings | null {
    if (breaker === null) return null;
    const { maxFailures, failureWindowMs } = breaker;
    const ok =
      Number.isInteger(maxFailures) &&
      maxFailures >= 1 &&
      maxFailures <= 1000 &&
      Number.isInteger(failureWindowMs) &&
      failureWindowMs >= 1000 &&
      failureWindowMs <= 3_600_000;
    if (!ok) throw ApiError.badRequest("Couldn't read the circuit breaker settings");
    return { maxFailures, failureWindowMs };
  }

  /**
   * The settings columns of a save: the type's `validate` runs on the settings with the kept secrets merged back,
   * then the secrets are split out and encrypted. Nothing given on an update keeps the stored columns. A blank
   * secret slot keeps its stored value only while scheme, host and port are unchanged.
   */
  private storeSettings(
    tenantId: string,
    id: string,
    type: LogDestinationType,
    entry: DestinationTypeEntry,
    given: unknown,
    existing: LogDestinationRow | undefined,
  ): { settings?: Record<string, unknown>; secretsEnc?: string | null; lastError?: null } {
    if (given === undefined && existing) return {};
    if (given !== undefined && !isRecord(given)) throw ApiError.badRequest("Couldn't read the settings");
    const incoming = given ?? {};
    const cipher = this.deps.context().cipher;
    const binding = destinationSecretBinding(tenantId, id);
    const old: Record<string, string> = existing?.secretsEnc
      ? cipher.decrypt<Record<string, string>>(existing.secretsEnc, binding)
      : {};
    const kept = blankSecretKeys(type, incoming).filter((key) => Object.hasOwn(old, key));
    if (existing && kept.length > 0) {
      const before = destinationEndpoint(type, existing.settings);
      const after = destinationEndpoint(type, incoming);
      if (before === null || after === null || before !== after) throw ApiError.badRequest(ENDPOINT_CHANGED);
    }
    const merged = mergeDestinationSecrets(type, incoming, old);
    const invalid = entry.validate(merged);
    if (invalid) throw ApiError.badRequest(invalid);
    const split = splitDestinationSecrets(type, merged);
    return {
      settings: split.settings,
      secretsEnc: Object.keys(split.secrets).length > 0 ? cipher.encrypt(split.secrets, binding) : null,
      lastError: null,
    };
  }
}
