/**
 * P6-06 (S5 C0 stub, L3 fills it): the secret fields of a destination (`DESTINATION_SECRET_FIELDS`) split from its
 * settings on save and merged back for the sender; stored through `ctx.cipher` with binding
 * `{ tenantId, credentialId: 'logDestination:<id>' }`, blank on read. A blank on save keeps the stored value only
 * while the scheme, host and port of the webhook URL or Sentry DSN are unchanged.
 */
import type { LogDestinationType } from '@workflow/workflow';

export interface SplitSecrets {
  /** the settings with every secret value blank */
  settings: Record<string, unknown>;
  /** the secret values by field path */
  secrets: Record<string, string>;
}

/** stub (L3) */
export function splitDestinationSecrets(
  _type: LogDestinationType,
  _settings: Record<string, unknown>,
): SplitSecrets {
  throw new Error('not implemented (L3)');
}

/** stub (L3) */
export function mergeDestinationSecrets(
  _type: LogDestinationType,
  _settings: Record<string, unknown>,
  _secrets: Record<string, string>,
): Record<string, unknown> {
  throw new Error('not implemented (L3)');
}

/** the cipher binding of a destination's secrets */
export function destinationSecretBinding(tenantId: string, destinationId: string) {
  return { tenantId, credentialId: `logDestination:${destinationId}` };
}
