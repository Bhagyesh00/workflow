/**
 * The `$secrets` object (P4-07): `$secrets.<providerKey>.<secret>`, read only, with n8n's two errors.
 * It exists only while credential data is read (resolver.ts). The recording variant answers the same
 * reads without values, so that the engine itself says what an expression refers to (GHSA-jp7m).
 */
import { ExpressionError } from '@workflow/workflow';
import type { SecretProvider } from './types';

const TITLE = 'Could not load secrets';
const NOT_REACHABLE = 'The credential in use pulls secrets from an external store that is not reachable';
const NOT_FOUND = 'The credential in use tries to use secret from an external store that could not be found';

const ownErrors = new WeakSet<Error>();

function loadError(description: string): ExpressionError {
  const error = new ExpressionError(TITLE, { description });
  ownErrors.add(error);
  return error;
}

/** one of the two errors above, whose text is fixed */
export function isSecretsLoadError(error: unknown): error is ExpressionError {
  return error instanceof Error && ownErrors.has(error);
}

/** what the language and JSON ask of any object: an absent answer, not "secret not found" */
const LANGUAGE_READS = new Set([
  'toJSON',
  'then',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
]);

function readOnly(
  keys: () => string[],
  read: (name: string) => unknown,
  missing: () => ExpressionError,
): Record<string, unknown> {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      if (keys().includes(name)) return read(name);
      if (LANGUAGE_READS.has(name)) return undefined;
      throw missing();
    },
    has: (_target, name) => typeof name === 'string' && keys().includes(name),
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_target, name) =>
      typeof name === 'string' && keys().includes(name)
        ? { configurable: true, enumerable: true, value: read(name), writable: false }
        : undefined,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
}

/** an object secret (Vault KV, 1Password item) answers a missing field as a missing secret */
function wrapValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapValue);
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return readOnly(
      () => Object.keys(fields),
      (name) => wrapValue(fields[name]),
      () => loadError(NOT_FOUND),
    );
  }
  return value;
}

export interface SecretsView {
  keys(): string[];
  provider(providerKey: string): SecretProvider | undefined;
}

export type SecretsObject = Record<string, Record<string, unknown>>;

export function createSecretsProxy(view: SecretsView): SecretsObject {
  const ofProvider = (providerKey: string) => {
    const provider = view.provider(providerKey);
    if (!provider) throw loadError(NOT_REACHABLE);
    return readOnly(
      () => provider.getSecretNames(),
      (name) => wrapValue(provider.getSecret(name)),
      () => loadError(NOT_FOUND),
    );
  };
  return readOnly(
    () => view.keys(),
    (providerKey) => ofProvider(providerKey),
    () => loadError(NOT_REACHABLE),
  ) as SecretsObject;
}

/** no manager at hand: every read fails closed */
export function createUnavailableSecretsProxy(): SecretsObject {
  return createSecretsProxy({ keys: () => [], provider: () => undefined });
}

/**
 * Records every provider key read. A secret reads as an empty string, so string methods and field
 * reads carry on to the next reference. Only the branch the engine takes is seen; nothing but the
 * delete warning's count depends on this.
 */
export function createRecordingSecretsProxy(record: (providerKey: string) => void): SecretsObject {
  return new Proxy(Object.create(null) as SecretsObject, {
    get(_target, name) {
      if (typeof name !== 'string' || LANGUAGE_READS.has(name)) return undefined;
      record(name);
      return new Proxy(Object.create(null) as Record<string, unknown>, {
        get: (_inner, secret) => (typeof secret !== 'string' || LANGUAGE_READS.has(secret) ? undefined : ''),
      });
    },
  });
}
