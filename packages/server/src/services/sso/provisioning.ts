/**
 * P6-11 (L9): role provisioning from the identity provider (n8n's provisioning): manual, instance roles, or
 * instance and project roles; by claims or by rules (services/sso/role-rules.ts), exclusive. `resolve` runs
 * at every SSO sign-in before any account is made; a block denies it. An instance role change goes through
 * `changeMemberRole(..., { source: 'provisioning' })`. While a scope is managed, manual role edits are
 * refused (`assertInstanceRolesEditable`, `assertProjectRolesEditable`).
 * Stub from C0: `resolve` PASSES (`{ blocked: false }`, no role change) and both asserts PASS (no workspace
 * is managed before L9); the rest throws until L9.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TenantRow, UserRow } from '../../db/schema';

/** what the provider's claims give a person at sign-in; undefined fields change nothing */
export interface ProvisioningDecision {
  /** true: the sign-in is refused before any account is made (the default condition "block") */
  blocked: boolean;
  /** the workspace role slug to set (never `owner`) */
  instanceRole?: string;
  /** project id to project role slug; replaces the person's project roles when given */
  projectRoles?: Record<string, string>;
}

/** what blocks deleting a custom role: the rules that assign it */
export interface RuleBlocker {
  id: string;
  type: 'instance' | 'project';
  expression: string;
}

export class ProvisioningService {
  constructor(readonly deps: ServiceDeps) {}

  /** Stub (L9) PASSES: `{ blocked: false }`, nothing provisioned */
  async resolve(
    _tenant: TenantRow,
    _claims: DataObject,
    _user?: UserRow | null,
  ): Promise<ProvisioningDecision> {
    return { blocked: false };
  }

  /** applies a decision to a member (after `resolve`, inside the sign-in) */
  async apply(_tenantId: string, _userId: string, _decision: ProvisioningDecision): Promise<void> {
    throw new Error('not implemented (L9)');
  }

  /** refused while workspace roles come from the provider. Stub (L9) PASSES */
  async assertInstanceRolesEditable(_tenantId: string): Promise<void> {
    // stub (L9): PASSES
  }

  /** refused while project roles come from the provider. Stub (L9) PASSES */
  async assertProjectRolesEditable(_tenantId: string): Promise<void> {
    // stub (L9): PASSES
  }

  /** the rules that assign the role `slug` (services/roles.ts `delete` names them in its 409) */
  async ruleBlockers(_tenantId: string, _slug: string): Promise<RuleBlocker[]> {
    throw new Error('not implemented (L9)');
  }

  /** GET /rest/sso/provisioning/config */
  async getConfig(_tenantId: string): Promise<DataObject> {
    throw new Error('not implemented (L9)');
  }

  /** PATCH /rest/sso/provisioning/config; audit `provisioning.updated` */
  async saveConfig(_tenantId: string, _input: DataObject, _actorId: string | null): Promise<DataObject> {
    throw new Error('not implemented (L9)');
  }
}
