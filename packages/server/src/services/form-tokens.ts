/**
 * Form tokens (P4-01): the HMAC token n8n sends as `x-auth-token` after Basic auth or form sign-in.
 * The caller's payload names tenant, workflow, node and credential or user; the server adds the
 * expiry. `<payload>.<signature>`, both base64url. Never logged, never in a URL.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { ExecutionServices } from '@workflow/core';
import { type DataObject, isPlainObject } from '@workflow/workflow';
import type { ServiceDeps } from '../context';

const MAX_TOKEN_LENGTH = 4096;

export class FormTokenService implements NonNullable<ExecutionServices['formTokens']> {
  /** one key per master key, the current one first: tokens signed before a rotation stay valid */
  private derivedKeys?: Buffer[];

  constructor(readonly deps: ServiceDeps) {}

  private get keys(): Buffer[] {
    this.derivedKeys ??= this.deps.config.encryptionKeys.map(({ key }) =>
      Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from('form-token:v1'), 32)),
    );
    return this.derivedKeys;
  }

  sign(payload: DataObject, ttlSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
    const signature = createHmac('sha256', this.keys[0]).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  /** the payload, or null for a bad or expired token */
  verify(token: string): DataObject | null {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, signature] = parts;
    const given = Buffer.from(signature, 'base64url');
    const signed = this.keys.some((key) => {
      const expected = createHmac('sha256', key).update(body).digest();
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!signed) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const { exp, ...payload } = parsed as DataObject;
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;
    return payload;
  }
}
