/**
 * Credential data with secrets (P4-07). `$secrets` resolves only here, while credential data is read
 * (provider().get, OAuth1, OAuth2, the credential test), via evaluateSimple over {$secrets, $vars}; it
 * is undefined in node parameters and Code (GHSA-2434). Stub until L9.
 */
import type { DataObject } from '@workflow/workflow';
import { ApiError } from '../../http/errors';
import type { SecretsManager } from './manager';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export interface ResolveCredentialDataOptions {
  tenantId: string;
  vars: Record<string, unknown>;
  /** where `$secrets` comes from */
  secrets?: Pick<SecretsManager, 'secretsFor'>;
}

/** A copy of `raw` with its expression leaves resolved; the stored expression stays as it is. */
export async function resolveCredentialData(
  _raw: DataObject,
  _options: ResolveCredentialDataOptions,
): Promise<DataObject> {
  throw notBuilt();
}

/**
 * The provider keys `raw` refers to, for credentials.secret_keys. Runs the same engine over a recording
 * `$secrets` proxy, never a regex (GHSA-jp7m).
 */
export function collectSecretKeys(_raw: DataObject): string[] {
  throw notBuilt();
}
