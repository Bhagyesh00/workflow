/**
 * Credential data with secrets (P4-07). `$secrets` resolves only here, while credential data is read
 * (provider().get, OAuth1, OAuth2, the credential test), via evaluateSimple over {$secrets, $vars}; it
 * is undefined in node parameters and Code (GHSA-2434). The stored expression stays as it is.
 */

import { isCredentialExpression } from '@workflow/core';
import { type DataObject, ExpressionError, evaluateSimple } from '@workflow/workflow';
import type { SecretsManager } from './manager';
import { createRecordingSecretsProxy, createUnavailableSecretsProxy, isSecretsLoadError } from './proxy';

/** provider-issued token material is never an expression */
const NEVER_EVALUATED = new Set(['oauthTokenData']);
const LIMITS = { timeoutMs: 1000, maxSteps: 1_000_000 };

export interface ResolveCredentialDataOptions {
  tenantId: string;
  /** P6 S1: the credential's project (null or absent: none); `secretsFor` gets it */
  projectId?: string | null;
  vars: Record<string, unknown>;
  /** where `$secrets` comes from */
  secrets?: Pick<SecretsManager, 'secretsFor'>;
}

/** every expression leaf of `value`, deep */
function expressionLeaves(value: unknown, out: string[] = []): string[] {
  if (isCredentialExpression(value)) out.push(value);
  else if (Array.isArray(value)) for (const item of value) expressionLeaves(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!NEVER_EVALUATED.has(key)) expressionLeaves(item, out);
    }
  }
  return out;
}

export function hasCredentialExpressions(raw: DataObject): boolean {
  return expressionLeaves(raw).length > 0;
}

/**
 * The only error text that leaves a read. An engine or native error can quote its input, such as
 * JSON.parse on a secret, so it is never passed on.
 */
function evaluateLeaf(expression: string, variables: Record<string, unknown>): unknown {
  try {
    const value = evaluateSimple(expression, variables, LIMITS);
    // a value out of the proxy becomes plain data here
    return value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  } catch (error) {
    if (isSecretsLoadError(error)) throw error;
    throw new ExpressionError('Could not read the credential', {
      description: 'An expression in the credential could not be evaluated',
    });
  }
}

function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (isCredentialExpression(value)) return evaluateLeaf(value, variables);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        NEVER_EVALUATED.has(key) ? item : resolveValue(item, variables),
      ]),
    );
  }
  return value;
}

/** A copy of `raw` with its expression leaves resolved once; a value a secret returned is not read again. */
export async function resolveCredentialData(
  raw: DataObject,
  options: ResolveCredentialDataOptions,
): Promise<DataObject> {
  const variables = {
    $secrets: options.secrets
      ? options.secrets.secretsFor(options.tenantId, options.projectId)
      : createUnavailableSecretsProxy(),
    $vars: Object.freeze({ ...options.vars }),
  };
  return resolveValue(raw, variables) as DataObject;
}

/**
 * The provider keys `raw` refers to, for credentials.secret_keys. Runs the same engine over a recording
 * `$secrets` proxy, never a regex (GHSA-jp7m). A failing expression still reports what it read so far.
 */
export function collectSecretKeys(raw: DataObject, vars: Record<string, unknown> = {}): string[] {
  const keys = new Set<string>();
  const variables = {
    $secrets: createRecordingSecretsProxy((key) => keys.add(key)),
    $vars: Object.freeze({ ...vars }),
  };
  for (const expression of expressionLeaves(raw)) {
    try {
      evaluateSimple(expression, variables, LIMITS);
    } catch {
      // saved as typed: the read reports it
    }
  }
  return [...keys].sort();
}

/** the text of a read error, which is fixed (see evaluateLeaf) */
export function credentialReadErrorText(error: unknown): string {
  if (isSecretsLoadError(error) || error instanceof ExpressionError) {
    return error.description ? `${error.message}: ${error.description}` : error.message;
  }
  return 'Could not read the credential';
}

/** the strings a read produced from expressions, to keep out of an answer */
export function resolvedValues(raw: unknown, resolved: unknown, out: string[] = []): string[] {
  if (isCredentialExpression(raw)) collectStrings(resolved, out);
  else if (Array.isArray(raw) && Array.isArray(resolved)) {
    for (const [index, item] of raw.entries()) resolvedValues(item, resolved[index], out);
  } else if (raw && resolved && typeof raw === 'object' && typeof resolved === 'object') {
    for (const [key, item] of Object.entries(raw)) {
      resolvedValues(item, (resolved as Record<string, unknown>)[key], out);
    }
  }
  return out;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/** `text` with each of `values` taken out; shorter ones would only garble it */
export function scrubValues(text: string, values: string[]): string {
  let out = text;
  for (const value of values) if (value.length >= 4) out = out.split(value).join('***');
  return out;
}
