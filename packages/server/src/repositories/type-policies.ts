/**
 * P6-48 (L1): the type policy tables (`type_policy_scopes`, `type_policies`, `type_policy_attachments`,
 * migration 0032). Every query filters tenant_id. The attachment's policy key is NO ACTION and deferred, so
 * an attached policy's delete fails at COMMIT (or at the statement after `SET CONSTRAINTS ALL IMMEDIATE`).
 * Stub from C0; L1 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { TypePolicyAttachmentRow, TypePolicyRow, TypePolicyScopeRow } from '../db/schema';

export type TypePolicyKindValue = TypePolicyScopeRow['kind'];

/** one tenant's three tables at once, for the snapshot */
export interface TenantTypePolicyRows {
  scopes: TypePolicyScopeRow[];
  policies: TypePolicyRow[];
  attachments: TypePolicyAttachmentRow[];
}

export class TypePolicyRepository {
  constructor(protected readonly db: DbOrTx) {}

  async getScope(
    _tenantId: string,
    _kind: TypePolicyKindValue,
    _projectId: string | null,
  ): Promise<TypePolicyScopeRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  /** inserts at version 1 when `expectedVersion` is 0, else updates where the version matches; undefined when stale */
  async writeScope(
    _tenantId: string,
    _input: {
      kind: TypePolicyKindValue;
      projectId: string | null;
      defaultAction: TypePolicyScopeRow['defaultAction'];
      expectedVersion: number;
    },
  ): Promise<TypePolicyScopeRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  async listPolicies(_tenantId: string, _kind: TypePolicyKindValue): Promise<TypePolicyRow[]> {
    throw new Error('not implemented (L1)');
  }

  async getPolicy(_tenantId: string, _policyId: string): Promise<TypePolicyRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  async insertPolicy(
    _tenantId: string,
    _input: { kind: TypePolicyKindValue; name: string; description: string | null; rules: unknown[] },
  ): Promise<TypePolicyRow> {
    throw new Error('not implemented (L1)');
  }

  /** undefined when the version is stale */
  async updatePolicy(
    _tenantId: string,
    _policyId: string,
    _patch: { name?: string; description?: string | null; rules?: unknown[] },
    _expectedVersion: number,
  ): Promise<TypePolicyRow | undefined> {
    throw new Error('not implemented (L1)');
  }

  async deletePolicy(_tenantId: string, _policyId: string): Promise<boolean> {
    throw new Error('not implemented (L1)');
  }

  async listAttachments(_tenantId: string, _scopeId: string): Promise<TypePolicyAttachmentRow[]> {
    throw new Error('not implemented (L1)');
  }

  async replaceAttachments(
    _tenantId: string,
    _scopeId: string,
    _rows: Array<{ policyId: string; priority: number; isFloor: boolean }>,
  ): Promise<TypePolicyAttachmentRow[]> {
    throw new Error('not implemented (L1)');
  }

  /** the scopes that attach a policy (a delete is refused while any does) */
  async scopesAttaching(_tenantId: string, _policyId: string): Promise<string[]> {
    throw new Error('not implemented (L1)');
  }

  async loadTenant(_tenantId: string): Promise<TenantTypePolicyRows> {
    throw new Error('not implemented (L1)');
  }
}
