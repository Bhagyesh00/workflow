/**
 * P6-21 (L5): API key management beyond create and list: edit (name, scopes), rotate, expiry, the scopes a
 * role may give (`apiKeyScopesForRole`), the admin's view of every key (`apiKey:manage`) and revoke with a
 * mail to the owner. `onRoleChange` strips the scopes a member's new role no longer allows (called by
 * services/member-disable.ts `changeMemberRole`). Every query keeps `audience = 'public-api'` (P5-04), so
 * an MCP key is never listed or touched.
 */
import { PROJECT_ROLE_SCOPES } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { Role } from '../db/schema';
import { API_KEY_SCOPES, type ApiKeyScope, apiKeyScopesForRole } from '../http/api-key-scopes';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
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

/** n8n's label rules: 1 to 50 characters, no markup */
export const API_KEY_LABEL_MAX = 50;
const LABEL_TAKEN = 'There is already an API key with this label';

export class ApiKeyService {
  constructor(readonly deps: ServiceDeps) {}

  /** the scopes the caller's role may give a key */
  async scopesFor(auth: AuthContext): Promise<ApiKeyScope[]> {
    return this.scopesOfRole(auth.tenant.id, auth.role);
  }

  /**
   * `apiKeyScopesForRole` (global scopes plus a personal project owner's), and the key scopes whose route
   * checks a user scope under another name (`workflow:activate` is checked as `workflow:publish`, a data
   * table row as `dataTable:readRow`): a role may give those when it holds the route's own scope, globally or
   * as the owner of its personal project. Without them no one could give a key such a scope.
   */
  private async scopesOfRole(tenantId: string, role: Role): Promise<ApiKeyScope[]> {
    const held = await this.deps.context().access.globalScopes(tenantId, role);
    const base = new Set<string>(apiKeyScopesForRole(held));
    const personal = PROJECT_ROLE_SCOPES['project:personalOwner'];
    // loaded when first used: the route table imports the services
    const { PUBLIC_ROUTES } = await import('../routes/public-api');
    for (const route of PUBLIC_ROUTES) {
      if (!route.scope || base.has(route.scope) || !('scope' in route.access)) continue;
      const needed = typeof route.access.scope === 'string' ? [route.access.scope] : route.access.scope;
      if (needed.some((scope) => held.has(scope) || personal.has(scope))) base.add(route.scope);
    }
    return API_KEY_SCOPES.filter((scope) => base.has(scope));
  }

  /** 400 "Invalid scopes for user role" when a scope is above what the caller's role gives (create and patch) */
  async assertScopesAllowed(auth: AuthContext, scopes: readonly string[]): Promise<void> {
    if (!scopes.length) return;
    const allowed = new Set<string>(await this.scopesFor(auth));
    if (scopes.some((scope) => !allowed.has(scope)))
      throw ApiError.badRequest('Invalid scopes for user role');
  }

  /** a label is unique among the owner's keys (`exceptId`: the key being renamed) */
  async assertLabelFree(tenantId: string, userId: string, label: string, exceptId?: string): Promise<void> {
    const own = await this.deps.repos.apiKeys.list(tenantId, userId);
    if (own.some((key) => key.id !== exceptId && key.name === label)) throw ApiError.badRequest(LABEL_TAKEN);
  }

  async update(auth: AuthContext, id: string, input: ApiKeyUpdateInput): Promise<ApiKeyListRow> {
    const { repos } = this.deps;
    const tenantId = auth.tenant.id;
    const current = (await repos.apiKeys.list(tenantId, auth.user.id)).find((key) => key.id === id);
    if (!current) throw ApiError.notFound('API key');
    if (input.scopes) await this.assertScopesAllowed(auth, input.scopes);
    if (input.name !== undefined && input.name !== current.name) {
      await this.assertLabelFree(tenantId, auth.user.id, input.name, id);
    }
    const scopes = input.scopes ? [...new Set(input.scopes)] : undefined;
    const row = await repos.apiKeys.update(tenantId, auth.user.id, id, {
      name: input.name,
      scopes,
    });
    if (!row) throw ApiError.notFound('API key');
    await repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'apikey.updated',
      resourceType: 'api_key',
      resourceId: id,
    });
    return row;
  }

  async rotate(auth: AuthContext, id: string): Promise<RotatedApiKey> {
    const rotated = await this.deps.context().auth.rotateApiKey(auth.tenant.id, auth.user.id, id);
    await this.deps.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'apikey.rotated',
      resourceType: 'api_key',
      resourceId: id,
    });
    return rotated;
  }

  private async requireManage(auth: AuthContext): Promise<void> {
    const held = await this.deps.context().access.scopesForAuth(auth);
    if (!held.has('apiKey:manage'))
      throw ApiError.forbidden('User is missing a scope required to perform this action');
  }

  /** GET /api-keys?scope=all (`apiKey:manage`): every key of the workspace, with its owner */
  async listAll(
    auth: AuthContext,
    filter: { userId?: string; name?: string },
  ): Promise<ApiKeyWithOwnerRow[]> {
    await this.requireManage(auth);
    return this.deps.repos.apiKeys.listAll(auth.tenant.id, filter);
  }

  /**
   * an admin revokes another member's key (`apiKey:manage`; 404 when not allowed, so a caller without the
   * scope learns nothing about other people's keys) and the owner is mailed
   */
  async revokeByAdmin(auth: AuthContext, id: string): Promise<void> {
    const { repos } = this.deps;
    const held = await this.deps.context().access.scopesForAuth(auth);
    if (!held.has('apiKey:manage')) throw ApiError.notFound('API key');
    const removed = await repos.apiKeys.deleteAny(auth.tenant.id, id);
    if (!removed) throw ApiError.notFound('API key');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'apikey.revoked_by_admin',
      resourceType: 'api_key',
      resourceId: id,
      metadata: { ownerId: removed.userId },
    });
    const owner = await repos.users.get(removed.userId);
    if (owner) {
      await this.deps.context().mailer.sendApiKeyRevoked(owner.email, {
        workspaceName: auth.tenant.name,
        keyLabel: removed.name,
        revokedBy: auth.user.name,
      });
    }
  }

  /**
   * after a role change: takes the scopes above the new role off the user's keys. A key left with none would
   * read as "every scope" (an empty list), so a key that loses all of its scopes is deleted instead.
   */
  async onRoleChange(tenantId: string, userId: string, role: Role): Promise<void> {
    const { repos } = this.deps;
    const allowed = new Set<string>(await this.scopesOfRole(tenantId, role));
    const above = API_KEY_SCOPES.filter((scope) => !allowed.has(scope));
    if (!above.length) return;
    const aboveSet = new Set<string>(above);
    for (const key of await repos.apiKeys.list(tenantId, userId)) {
      if (!key.scopes.some((scope) => aboveSet.has(scope))) continue;
      const kept = key.scopes.filter((scope) => !aboveSet.has(scope));
      if (kept.length) await repos.apiKeys.update(tenantId, userId, key.id, { scopes: kept });
      else await repos.apiKeys.delete(tenantId, userId, key.id);
    }
  }
}
