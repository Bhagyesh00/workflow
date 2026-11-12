/**
 * P6-06 (S5 C0 stub, L3 fills it): one `LogStreamingManager` per process. It loads a tenant's destinations on its
 * first event, reloads on bus channel `log-destinations:reload` `{ tenantId }`, keeps one bounded queue, breaker and
 * sender per destination, and answers the REST and public routes (`/eventbus/*`, `/settings/log-streaming/*`).
 * stub (L3): the constructor (registers the three types) and `sink` (`accepts` false) PASS, `registerType` and
 * `close` pass, every route method throws.
 */
import type {
  CircuitBreakerSettings,
  LogDestination,
  LogDestinationTestResult,
  LogDestinationType,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { EventSink } from '../events/stream';
import { createSentrySender, validateSentrySettings } from './destinations/sentry';
import { createSyslogSender, validateSyslogSettings } from './destinations/syslog';
import { createWebhookSender, validateWebhookSettings } from './destinations/webhook';
import type { DestinationTypeEntry } from './types';

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

export class LogStreamingManager {
  /** the event stream's sink: accepts only events an enabled destination of the tenant subscribes to */
  readonly sink: EventSink;
  /** the registered destination types */
  protected readonly types = new Map<LogDestinationType, DestinationTypeEntry>();

  constructor(readonly deps: ServiceDeps) {
    // stub (L3): PASSES: the three types are registered, the sink accepts nothing
    this.registerType('webhook', { create: createWebhookSender, validate: validateWebhookSettings });
    this.registerType('syslog', { create: createSyslogSender, validate: validateSyslogSettings });
    this.registerType('sentry', { create: createSentrySender, validate: validateSentrySettings });
    this.sink = { accepts: () => false, deliver: () => {} };
  }

  /** a later call for the same type replaces the entry (tests register a fake sender type this way) */
  registerType(type: LogDestinationType, entry: DestinationTypeEntry): void {
    this.types.set(type, entry);
  }

  /** stub (L3): the workspace's destinations, secrets blank */
  list(_auth: AuthContext): Promise<LogDestination[]> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): one destination of the workspace, secrets blank; another tenant's id is 404 */
  get(_auth: AuthContext, _id: string): Promise<LogDestination> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): creates or updates a destination and reloads it on every process */
  save(_auth: AuthContext, _input: LogDestinationInput): Promise<LogDestination> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): deletes a destination (its failed events go with it) */
  remove(_auth: AuthContext, _id: string): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): sends `destination.test` past the breaker; the error text is redacted */
  test(_auth: AuthContext, _id: string): Promise<LogDestinationTestResult> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): PASSES: drains the queues and closes the senders (called by the context's `close`) */
  async close(): Promise<void> {}
}
