/**
 * P6-48 (L1): the type policy store: one scope per kind and project (default action, version, attachments),
 * documents of ordered rules. An unwritten scope reads as allow at version 0, and its first write sends
 * `expectedVersion` 0. A stale write gets 409; one write gives version + 1. A write runs in a transaction and
 * invalidates the tenant's snapshot after commit. An attached document cannot be deleted (409).
 * `projectId` null is the workspace scope.
 * Stub from C0: the constructor PASSES (createContext builds it); every method throws until L1.
 */
import type { ServiceDeps } from '../../context';
import type {
  PolicyAttachment,
  PolicyDocument,
  PolicyDocumentInput,
  PolicyKind,
  PolicyScope,
  PolicyScopeInput,
  PolicyWarning,
} from './types';

/** a document write answers the document and the lint warnings */
export interface PolicyWriteResult {
  policy: PolicyDocument;
  warnings: PolicyWarning[];
}

export class TypePolicyStore {
  constructor(readonly deps: ServiceDeps) {}

  async getScope(_tenantId: string, _kind: PolicyKind, _projectId: string | null): Promise<PolicyScope> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  async putScope(
    _tenantId: string,
    _kind: PolicyKind,
    _projectId: string | null,
    _input: PolicyScopeInput,
    _expectedVersion: number,
  ): Promise<PolicyScope> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  async listPolicies(_tenantId: string, _kind: PolicyKind): Promise<PolicyDocument[]> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  /** 404 when the document is not this tenant's or not this kind */
  async getPolicy(_tenantId: string, _kind: PolicyKind, _policyId: string): Promise<PolicyDocument> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  async createPolicy(
    _tenantId: string,
    _kind: PolicyKind,
    _input: PolicyDocumentInput,
    _userId?: string,
  ): Promise<PolicyWriteResult> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  async updatePolicy(
    _tenantId: string,
    _kind: PolicyKind,
    _policyId: string,
    _patch: Partial<PolicyDocumentInput>,
    _expectedVersion: number,
    _userId?: string,
  ): Promise<PolicyWriteResult> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  /** 409 while a scope attaches it */
  async deletePolicy(
    _tenantId: string,
    _kind: PolicyKind,
    _policyId: string,
    _userId?: string,
  ): Promise<void> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  async getAttachments(_tenantId: string, _scopeId: string): Promise<PolicyAttachment[]> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }

  /** replaces the scope's attachments; raises the scope's version */
  async putAttachments(
    _tenantId: string,
    _scopeId: string,
    _attachments: PolicyAttachment[],
    _expectedVersion: number,
  ): Promise<PolicyScope> {
    // stub (L1)
    throw new Error('not implemented (L1)');
  }
}
