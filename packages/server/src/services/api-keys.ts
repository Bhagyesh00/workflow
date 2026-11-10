/**
 * P6-21 (L5): API key management beyond create and list: edit (name, scopes), rotate, expiry, the scopes a
 * role may give (`apiKeyScopesForRole`), the admin's view of every key (`apiKey:manage`) and revoke with a
 * mail to the owner. `onRoleChange` strips the scopes a member's new role no longer allows (called by
 * services/member-disable.ts `changeMemberRole`). Every query keeps `audience = 'public-api'` (P5-04), so
 * an MCP key is never listed or touched.
 * Stub from C0: `onRoleChange` PASSES (keeps every key as today); the rest throws until L5.
 */
import type { ServiceDeps } from '../context';
import type { Role } from '../db/schema';
import type { ApiKeyScope } from '../http/api-key-scopes';
import type { AuthContext } from '../http/auth';
import type { ApiKeyListRow, ApiKeyWithOwnerRow } from '../repositories';

export interface ApiKeyUpdateInput {
  name?: string;
  scopes?: ApiKeyScope[];
}

/** a rotated key: the new secret is shown once */
export interface RotatedApiKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
}

export class ApiKeyService {
  constructor(readonly deps: ServiceDeps) {}

  async update(_auth: AuthContext, _id: string, _input: ApiKeyUpdateInput): Promise<ApiKeyListRow> {
    throw new Error('not implemented (L5)');
  }

  async rotate(_auth: AuthContext, _id: string): Promise<RotatedApiKey> {
    throw new Error('not implemented (L5)');
  }

  /** GET /api-keys?scope=all (`apiKey:manage`): every key of the workspace, with its owner */
  async listAll(
    _auth: AuthContext,
    _filter: { userId?: string; name?: string },
  ): Promise<ApiKeyWithOwnerRow[]> {
    throw new Error('not implemented (L5)');
  }

  /** the scopes the caller's role may give a key */
  async scopesFor(_auth: AuthContext): Promise<ApiKeyScope[]> {
    throw new Error('not implemented (L5)');
  }

  /** an admin revokes another member's key (`apiKey:manage`; 404 when not allowed) and mails the owner */
  async revokeByAdmin(_auth: AuthContext, _id: string): Promise<void> {
    throw new Error('not implemented (L5)');
  }

  /** after a role change: strips the scopes above the new role. Stub (L5) PASSES: keys unchanged */
  async onRoleChange(_tenantId: string, _userId: string, _role: Role): Promise<void> {
    // stub (L5): PASSES
  }
}
