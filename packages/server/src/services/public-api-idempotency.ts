/**
 * P6-82 (L15): the public API's `Idempotency-Key` (POST only, except the last path segments activate,
 * deactivate, disconnect, publish, unpublish, archive, unarchive, transfer, test, test-trace). Unique per
 * tenant, user and key; 12 hours. Another body with the key 422 "This Idempotency-Key was already used with a
 * different request."; still running 409 "A request with this Idempotency-Key is already in progress."; the
 * first success replays; an error releases. `beginIdempotent` deletes an expired row of that user and key and
 * claims again. The stored answer goes into `response_enc` through `CredentialCipher` only.
 */
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

/** 12 hours */
export const IDEMPOTENCY_TTL_MS = 12 * 60 * 60 * 1000;

export interface IdempotencyKeyRef {
  tenantId: string;
  userId: string;
  key: string;
}

/** `claimed`: run the request, then finish or release; `replay`: answer the stored response */
export type IdempotencyBegin = { kind: 'claimed' } | { kind: 'replay'; statusCode: number; body: unknown };

/** the cipher binding of a stored answer: the row's own key, so a copy into another row fails to decrypt */
const bindingOf = (ref: IdempotencyKeyRef) => ({
  tenantId: ref.tenantId,
  credentialId: `public-api-idempotency:${ref.userId}:${ref.key}`,
});

export async function beginIdempotent(
  deps: ServiceDeps,
  ref: IdempotencyKeyRef,
  /** a hash of method, path, query and parsed body */
  fingerprint: string,
): Promise<IdempotencyBegin> {
  const repo = deps.repos.publicIdempotency;
  const cipher = deps.context().cipher;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await repo.claim(ref.tenantId, ref.userId, ref.key, fingerprint)) return { kind: 'claimed' };
    const row = await repo.get(ref.tenantId, ref.userId, ref.key);
    // released between the claim and the read: claim again
    if (!row) continue;
    // the Pruner runs hourly, so an expired row is removed here, then the key is claimed again
    if (row.createdAt.getTime() <= Date.now() - IDEMPOTENCY_TTL_MS) {
      await repo.deleteExpired(ref.tenantId, ref.userId, ref.key, new Date(Date.now() - IDEMPOTENCY_TTL_MS));
      continue;
    }
    if (row.fingerprint !== fingerprint) {
      throw new ApiError(
        422,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (row.status === 'done' && row.statusCode !== null && row.responseEnc) {
      const stored = cipher.decrypt<{ body: unknown }>(row.responseEnc, bindingOf(ref));
      return { kind: 'replay', statusCode: row.statusCode, body: stored.body };
    }
    throw ApiError.conflict('A request with this Idempotency-Key is already in progress.');
  }
  throw ApiError.conflict('A request with this Idempotency-Key is already in progress.');
}

export async function finishIdempotent(
  deps: ServiceDeps,
  ref: IdempotencyKeyRef,
  statusCode: number,
  body: unknown,
): Promise<void> {
  // `undefined` has no JSON form: a reply without a body is stored as null
  const responseEnc = deps.context().cipher.encrypt({ body: body ?? null }, bindingOf(ref));
  await deps.repos.publicIdempotency.finish(ref.tenantId, ref.userId, ref.key, { statusCode, responseEnc });
}

export async function releaseIdempotent(deps: ServiceDeps, ref: IdempotencyKeyRef): Promise<void> {
  await deps.repos.publicIdempotency.release(ref.tenantId, ref.userId, ref.key);
}
