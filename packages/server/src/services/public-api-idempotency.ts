/**
 * P6-82 (L15): the public API's `Idempotency-Key` (POST only, except the last path segments activate,
 * deactivate, disconnect, publish, unpublish, archive, unarchive, transfer, test, test-trace). Unique per
 * tenant, user and key; 12 hours. Another body with the key 422 "This Idempotency-Key was already used with a
 * different request."; still running 409 "A request with this Idempotency-Key is already in progress."; the
 * first success replays; an error releases. `beginIdempotent` deletes an expired row of that user and key and
 * claims again. The stored answer goes into `response_enc` through `CredentialCipher` only.
 * Stub from C0; L15 fills it (nothing calls it until L15 wires routes/public-api.ts).
 */
import type { ServiceDeps } from '../context';

/** 12 hours */
export const IDEMPOTENCY_TTL_MS = 12 * 60 * 60 * 1000;

export interface IdempotencyKeyRef {
  tenantId: string;
  userId: string;
  key: string;
}

/** `claimed`: run the request, then finish or release; `replay`: answer the stored response */
export type IdempotencyBegin = { kind: 'claimed' } | { kind: 'replay'; statusCode: number; body: unknown };

export async function beginIdempotent(
  _deps: ServiceDeps,
  _ref: IdempotencyKeyRef,
  /** a hash of method, path, query and parsed body */
  _fingerprint: string,
): Promise<IdempotencyBegin> {
  // stub (L15)
  throw new Error('not implemented (L15)');
}

export async function finishIdempotent(
  _deps: ServiceDeps,
  _ref: IdempotencyKeyRef,
  _statusCode: number,
  _body: unknown,
): Promise<void> {
  // stub (L15)
  throw new Error('not implemented (L15)');
}

export async function releaseIdempotent(_deps: ServiceDeps, _ref: IdempotencyKeyRef): Promise<void> {
  // stub (L15)
  throw new Error('not implemented (L15)');
}
