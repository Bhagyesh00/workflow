/**
 * Form tokens (P4-01): the HMAC token n8n sends as `x-auth-token` after Basic auth or form sign-in,
 * over a server secret with tenant, workflow, node, credential or user, and expiry. Stub until L1.
 */
import type { ExecutionServices } from '@workflow/core';
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export class FormTokenService implements NonNullable<ExecutionServices['formTokens']> {
  constructor(readonly deps: ServiceDeps) {}

  sign(_payload: DataObject, _ttlSeconds: number): string {
    throw notBuilt();
  }

  /** the payload, or null for a bad or expired token */
  verify(_token: string): DataObject | null {
    throw notBuilt();
  }
}
