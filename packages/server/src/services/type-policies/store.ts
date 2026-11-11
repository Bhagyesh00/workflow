/**
 * P6-48 (L1): the type policy store: one scope per kind and project (default action, version, attachments),
 * documents of ordered rules. An unwritten scope reads as allow at version 0, and its first write sends
 * `expectedVersion` 0. A stale write gets 409; one write gives version + 1 (a document write also raises the
 * version of every scope that attaches it). A write runs in a transaction and invalidates the tenant's
 * snapshot after commit. An attached document cannot be deleted (409). `projectId` null is the workspace
 * scope; a project scope never delegates (its default, and the rules of a document it attaches).
 */
import type { ServiceDeps } from '../../context';
import type { TypePolicyAttachmentRow, TypePolicyRow, TypePolicyScopeRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { createRepositories, isUniqueViolation, pgErrorCode } from '../../repositories';
import type { TypePolicyRepository } from '../../repositories/type-policies';
import { assertNoDelegate, type KnownTypes, lintRules } from './lint';
import type {
  PolicyAttachment,
  PolicyDocument,
  PolicyDocumentInput,
  PolicyKind,
  PolicyRule,
  PolicyScope,
  PolicyScopeInput,
  PolicyWarning,
} from './types';

/** a document write answers the document and the lint warnings */
export interface PolicyWriteResult {
  policy: PolicyDocument;
  warnings: PolicyWarning[];
}

const NAME_MAX = 255;
const DESCRIPTION_MAX = 512;

export function documentFromRow(row: TypePolicyRow): PolicyDocument {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    rules: row.rules as PolicyRule[],
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function attachmentFromRow(row: TypePolicyAttachmentRow): PolicyAttachment {
  return { policyId: row.policyId, priority: row.priority, isFloor: row.isFloor };
}

/** a scope with its attachments (floors first, then by priority) */
export function scopeFromRow(row: TypePolicyScopeRow, attachments: TypePolicyAttachmentRow[]): PolicyScope {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    projectId: row.projectId,
    defaultAction: row.defaultAction,
    version: row.version,
    attachments: attachments.map(attachmentFromRow),
  };
}

/** what an unwritten scope reads as: allow all at version 0 */
export function unwrittenScope(tenantId: string, kind: PolicyKind, projectId: string | null): PolicyScope {
  return { id: null, tenantId, kind, projectId, defaultAction: 'allow', version: 0, attachments: [] };
}

const NAME_TAKEN = 'A policy with this name already exists';
const stale = () => ApiError.conflict('The policy changed since it was read. Reload it and try again');

export class TypePolicyStore {
  constructor(readonly deps: ServiceDeps) {}

  async getScope(tenantId: string, kind: PolicyKind, projectId: string | null): Promise<PolicyScope> {
    const repo = this.deps.repos.typePolicies;
    const row = await repo.getScope(tenantId, kind, projectId);
    if (!row) return unwrittenScope(tenantId, kind, projectId);
    return scopeFromRow(row, await repo.listAttachments(tenantId, row.id));
  }

  async putScope(
    tenantId: string,
    kind: PolicyKind,
    projectId: string | null,
    input: PolicyScopeInput,
    expectedVersion: number,
  ): Promise<PolicyScope> {
    if (projectId !== null) {
      if (input.defaultAction === 'delegate') throw ApiError.badRequest('A project policy cannot delegate');
      if (!(await this.deps.repos.projects.get(tenantId, projectId))) throw ApiError.notFound('Project');
    }
    const scope = await this.write(async (repo) => {
      const row = await repo.writeScope(tenantId, {
        kind,
        projectId,
        defaultAction: input.defaultAction,
        expectedVersion,
      });
      if (!row) throw stale();
      if (input.attachments === undefined)
        return scopeFromRow(row, await repo.listAttachments(tenantId, row.id));
      await this.checkAttachments(repo, tenantId, kind, projectId, input.attachments);
      return scopeFromRow(row, await repo.replaceAttachments(tenantId, row.id, input.attachments));
    });
    await this.deps.context().policySnapshots.invalidate(tenantId);
    return scope;
  }

  async listPolicies(tenantId: string, kind: PolicyKind): Promise<PolicyDocument[]> {
    return (await this.deps.repos.typePolicies.listPolicies(tenantId, kind)).map(documentFromRow);
  }

  /** 404 when the document is not this tenant's or not this kind */
  async getPolicy(tenantId: string, kind: PolicyKind, policyId: string): Promise<PolicyDocument> {
    const row = await this.deps.repos.typePolicies.getPolicy(tenantId, policyId);
    if (!row || row.kind !== kind) throw ApiError.notFound('Policy');
    return documentFromRow(row);
  }

  async createPolicy(
    tenantId: string,
    kind: PolicyKind,
    input: PolicyDocumentInput,
    _userId?: string,
  ): Promise<PolicyWriteResult> {
    const name = this.checkName(input.name);
    const description = this.checkDescription(input.description);
    const warnings = lintRules(kind, input.rules, this.known(kind));
    const row = await this.write(
      (repo) => repo.insertPolicy(tenantId, { kind, name, description, rules: input.rules }),
      NAME_TAKEN,
    );
    await this.deps.context().policySnapshots.invalidate(tenantId);
    return { policy: documentFromRow(row), warnings };
  }

  async updatePolicy(
    tenantId: string,
    kind: PolicyKind,
    policyId: string,
    patch: Partial<PolicyDocumentInput>,
    expectedVersion: number,
    _userId?: string,
  ): Promise<PolicyWriteResult> {
    const name = patch.name === undefined ? undefined : this.checkName(patch.name);
    const description =
      patch.description === undefined ? undefined : this.checkDescription(patch.description);
    const result = await this.write(async (repo) => {
      const existing = await repo.getPolicy(tenantId, policyId);
      if (!existing || existing.kind !== kind) throw ApiError.notFound('Policy');
      const rules = patch.rules ?? (existing.rules as PolicyRule[]);
      const warnings = lintRules(kind, rules, this.known(kind));
      const attaching = await repo.scopesAttaching(tenantId, policyId);
      if (patch.rules !== undefined) await this.checkProjectRules(repo, tenantId, attaching, patch.rules);
      const row = await repo.updatePolicy(
        tenantId,
        policyId,
        { name, description, rules: patch.rules },
        expectedVersion,
      );
      if (!row) throw stale();
      await repo.bumpScopes(tenantId, attaching);
      return { policy: documentFromRow(row), warnings };
    }, NAME_TAKEN);
    await this.deps.context().policySnapshots.invalidate(tenantId);
    return result;
  }

  /** 409 while a scope attaches it, and 409 when `expectedVersion` is not the document's version */
  async deletePolicy(
    tenantId: string,
    kind: PolicyKind,
    policyId: string,
    expectedVersion: number,
    _userId?: string,
  ): Promise<void> {
    await this.write(async (repo) => {
      const existing = await repo.getPolicy(tenantId, policyId);
      if (!existing || existing.kind !== kind) throw ApiError.notFound('Policy');
      if ((await repo.scopesAttaching(tenantId, policyId)).length > 0) {
        throw ApiError.conflict('The policy is attached to a scope. Detach it before deleting it');
      }
      if (!(await repo.deletePolicy(tenantId, policyId, expectedVersion))) throw stale();
    });
    await this.deps.context().policySnapshots.invalidate(tenantId);
  }

  async getAttachments(tenantId: string, scopeId: string): Promise<PolicyAttachment[]> {
    return (await this.deps.repos.typePolicies.listAttachments(tenantId, scopeId)).map(attachmentFromRow);
  }

  /** replaces the scope's attachments; raises the scope's version */
  async putAttachments(
    tenantId: string,
    scopeId: string,
    attachments: PolicyAttachment[],
    expectedVersion: number,
  ): Promise<PolicyScope> {
    const scope = await this.write(async (repo) => {
      const existing = await repo.getScopeById(tenantId, scopeId);
      if (!existing) throw ApiError.notFound('Policy scope');
      await this.checkAttachments(repo, tenantId, existing.kind, existing.projectId, attachments);
      const row = await repo.touchScope(tenantId, scopeId, expectedVersion);
      if (!row) throw stale();
      return scopeFromRow(row, await repo.replaceAttachments(tenantId, scopeId, attachments));
    });
    await this.deps.context().policySnapshots.invalidate(tenantId);
    return scope;
  }

  /** the loaded type and package names of one kind (the lint's `notLoaded`) */
  private known(kind: PolicyKind): KnownTypes {
    const index = this.deps.context().policySnapshots.packageIndex;
    const source = kind === 'node' ? index.nodes : index.credentials;
    return { types: new Set(source.keys()), packages: new Set(source.values()) };
  }

  private checkName(value: string): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name === '') throw ApiError.badRequest('A policy needs a name');
    if (name.length > NAME_MAX)
      throw ApiError.badRequest(`A policy name holds at most ${NAME_MAX} characters`);
    return name;
  }

  private checkDescription(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (value.length > DESCRIPTION_MAX) {
      throw ApiError.badRequest(`A policy description holds at most ${DESCRIPTION_MAX} characters`);
    }
    return value;
  }

  /** the attachments name this tenant's documents of `kind`, once each, with a free priority per floor flag */
  private async checkAttachments(
    repo: TypePolicyRepository,
    tenantId: string,
    kind: PolicyKind,
    projectId: string | null,
    attachments: readonly PolicyAttachment[],
  ): Promise<void> {
    const ids = new Set<string>();
    const slots = new Set<string>();
    for (const attachment of attachments) {
      if (ids.has(attachment.policyId)) throw ApiError.badRequest('A policy is attached once per scope');
      ids.add(attachment.policyId);
      if (!Number.isInteger(attachment.priority) || attachment.priority < 0) {
        throw ApiError.badRequest('A priority is a whole number, 0 or more');
      }
      const slot = `${attachment.isFloor}:${attachment.priority}`;
      if (slots.has(slot)) throw ApiError.badRequest('Two attached policies share a priority');
      slots.add(slot);
    }
    const rows = await repo.getPolicies(tenantId, [...ids]);
    if (rows.length !== ids.size || rows.some((row) => row.kind !== kind)) throw ApiError.notFound('Policy');
    if (projectId !== null) for (const row of rows) assertNoDelegate(row.rules as PolicyRule[]);
  }

  /** a document that a project scope attaches cannot hold `delegate` */
  private async checkProjectRules(
    repo: TypePolicyRepository,
    tenantId: string,
    scopeIds: readonly string[],
    rules: readonly PolicyRule[],
  ): Promise<void> {
    if (!rules.some((rule) => rule.action === 'delegate')) return;
    for (const scopeId of scopeIds) {
      const scope = await repo.getScopeById(tenantId, scopeId);
      if (scope?.projectId) assertNoDelegate(rules);
    }
  }

  /** one transaction; a duplicate name or a stale attach or delete is a 409 */
  private async write<T>(
    work: (repo: TypePolicyRepository) => Promise<T>,
    duplicate = 'The policy changed since it was read. Reload it and try again',
  ): Promise<T> {
    try {
      return await this.deps.database.db.transaction(async (tx) => work(createRepositories(tx).typePolicies));
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict(duplicate);
      // the deferred policy key, checked at commit: the policy was deleted or attached in between
      if (pgErrorCode(error) === '23503') throw stale();
      throw error;
    }
  }
}
