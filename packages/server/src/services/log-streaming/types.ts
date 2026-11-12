/**
 * P6-06, P6-60..63 (S5 C0, FULL, C0-final): the contract between the log streaming manager (L3) and the destination
 * types (webhook L4, syslog L5, Sentry L6). The manager owns queues, breakers, secrets and the failed store; a type
 * gives a sender factory and a settings validator, registered with `LogStreamingManager.registerType`.
 */
import type { CredentialCipher, HttpClient } from '@workflow/core';
import type { LogDestinationSettingsByType, LogDestinationType } from '@workflow/workflow';
import type { Config } from '../../config';
import type { LogDestinationRow } from '../../db/schema';
import type { PinoLogger } from '../../logger';
import type { CredentialService } from '../credentials';
import type { StreamEvent } from '../events/stream';

/** sends events to one destination; `send` rejects on a failure (the manager counts it for the breaker) */
export interface DestinationSender {
  /** `test`: the destination's test message (`destination.test`), which skips the breaker */
  send(event: StreamEvent, options: { test?: boolean }): Promise<void>;
  /** closes sockets and timers (syslog TCP and TLS) */
  close?(): Promise<void>;
}

/** what a sender may use: every outbound call through `http` (the SSRF guard), every raw socket through `resolveAllowedHost` */
export interface SenderDeps {
  http: HttpClient;
  credentials: CredentialService;
  cipher: CredentialCipher;
  config: Config;
  logger: PinoLogger;
}

/**
 * A destination as a sender gets it: the row without the encrypted column, with `settings` typed by `type` and the
 * decrypted secret values (see `DESTINATION_SECRET_FIELDS`) merged back into `settings`. Never returned to a caller
 * that answers a request, never logged.
 */
export type StoredDestination = {
  [T in LogDestinationType]: Omit<LogDestinationRow, 'type' | 'settings' | 'secretsEnc'> & {
    type: T;
    settings: LogDestinationSettingsByType[T];
  };
}[LogDestinationType];

export type DestinationFactory = (deps: SenderDeps, destination: StoredDestination) => DestinationSender;

export interface DestinationTypeEntry {
  create: DestinationFactory;
  /** null when valid, else the 400 text */
  validate(settings: unknown): string | null;
}

/**
 * The settings fields that are secret per type: stored only in `secrets_enc` (`ctx.cipher.encrypt`, binding
 * `{ tenantId, credentialId: 'logDestination:<id>' }`), blank on read, never in a log, event or answer.
 * - webhook: the query values of `url`, every `headerParameters[].value`, every `queryParameters[].value`
 * - sentry: the public key of `dsn` (its user part)
 * - syslog: none (`tlsCa` is a public certificate)
 */
export const DESTINATION_SECRET_FIELDS: Readonly<Record<LogDestinationType, readonly string[]>> =
  Object.freeze({
    webhook: Object.freeze(['url.query', 'headerParameters[].value', 'queryParameters[].value']),
    syslog: Object.freeze([] as string[]),
    sentry: Object.freeze(['dsn.publicKey']),
  });
