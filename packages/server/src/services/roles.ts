/**
 * Custom roles (P6-32, L11): system roles live in code (workflow/src/permissions), custom project and
 * global roles in `roles` per workspace (`repos.roles`). Writes need `role:manage`, or
 * `role:manageProject` for project roles; scopes come from the allow lists (`customRoleAllowedScopes`);
 * a global custom role gets n8n's baseline. Texts as n8n: "Cannot delete system roles", "Cannot delete
 * role assigned to users" (unless `reassignRoleSlug`, global roles only, `user:changeRole`), "Cannot
 * update system roles", `A role with the name "..." already exists`. C0 stub: the constructor is real,
 * every method throws until L11. S3's P6-11 adds `roleDeletionCheck` to `delete`.
 */
import type { Scope } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';

const notImplemented = (): never => {
  throw new Error('not implemented (L11)');
};

/** POST /roles */
export interface RoleCreateInput {
  /** 2 to 100 characters */
  displayName: string;
  /** at most 500 characters */
  description?: string;
  roleType: 'project' | 'global';
  scopes: Scope[];
}

/** PATCH /roles/:slug */
export interface RoleUpdateInput {
  displayName?: string;
  description?: string;
  scopes?: Scope[];
}

export interface RoleDeleteOptions {
  /** global roles only: move the members holding the role to this slug (needs `user:changeRole`) */
  reassignRoleSlug?: string;
  /** who deletes it (audit log, and the `user:changeRole` check of `reassignRoleSlug`) */
  actor?: AuthContext;
}

export class RoleService {
  constructor(readonly deps: ServiceDeps) {}

  /** every role grouped by type (system and custom), with usage counts when asked */
  async list(_auth: AuthContext, _options: { withUsageCount?: boolean } = {}): Promise<unknown> {
    return notImplemented();
  }

  async get(
    _auth: AuthContext,
    _slug: string,
    _options: { withUsageCount?: boolean } = {},
  ): Promise<unknown> {
    return notImplemented();
  }

  async create(_auth: AuthContext, _input: RoleCreateInput): Promise<unknown> {
    return notImplemented();
  }

  async update(_auth: AuthContext, _slug: string, _patch: RoleUpdateInput): Promise<unknown> {
    return notImplemented();
  }

  async delete(_tenantId: string, _slug: string, _options: RoleDeleteOptions = {}): Promise<unknown> {
    return notImplemented();
  }

  /** the projects that use a project role, limited to those the caller can list */
  async assignments(_auth: AuthContext, _slug: string): Promise<unknown> {
    return notImplemented();
  }

  /** the members of one project holding the role (the project must be listable by the caller) */
  async projectMembers(_auth: AuthContext, _slug: string, _projectId: string): Promise<unknown> {
    return notImplemented();
  }

  /** the workspace members holding a global role */
  async members(_auth: AuthContext, _slug: string): Promise<unknown> {
    return notImplemented();
  }
}
