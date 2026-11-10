/**
 * P6-11 (L9): role mapping rules (`role_mapping_rules`, `role_mapping_rule_projects`), unique order per
 * (tenant, type). Stub from C0; L9 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { RoleMappingRuleRow } from '../db/schema';

export type RoleMappingRuleType = RoleMappingRuleRow['type'];

/** a rule with the projects it applies to (a project rule) */
export type RoleMappingRuleRecord = RoleMappingRuleRow & { projectIds: string[] };

export interface RoleMappingRuleInput {
  type: RoleMappingRuleType;
  expression: string;
  role: string;
  /** project rules only; each must be a project of the same workspace (composite FK) */
  projectIds?: string[];
}

export class RoleMappingRepository {
  constructor(protected readonly db: DbOrTx) {}

  async list(_tenantId: string, _type?: RoleMappingRuleType): Promise<RoleMappingRuleRecord[]> {
    throw new Error('not implemented (L9)');
  }

  async get(_tenantId: string, _id: string): Promise<RoleMappingRuleRecord | undefined> {
    throw new Error('not implemented (L9)');
  }

  /** appended after the last rule of its type unless `order` is given */
  async create(
    _tenantId: string,
    _input: RoleMappingRuleInput & { order?: number },
  ): Promise<RoleMappingRuleRecord> {
    throw new Error('not implemented (L9)');
  }

  async update(
    _tenantId: string,
    _id: string,
    _patch: Partial<RoleMappingRuleInput>,
  ): Promise<RoleMappingRuleRecord | undefined> {
    throw new Error('not implemented (L9)');
  }

  /** moves the rule to `order` within its type, shifting the others (two steps in one transaction) */
  async move(_tenantId: string, _id: string, _order: number): Promise<RoleMappingRuleRecord | undefined> {
    throw new Error('not implemented (L9)');
  }

  async delete(_tenantId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L9)');
  }

  /** deletes every rule of one type (project management turned off) */
  async deleteByType(_tenantId: string, _type: RoleMappingRuleType): Promise<number> {
    throw new Error('not implemented (L9)');
  }

  /** the rules that assign a role (the 409 of a role delete names them) */
  async listByRole(_tenantId: string, _role: string): Promise<RoleMappingRuleRecord[]> {
    throw new Error('not implemented (L9)');
  }
}
