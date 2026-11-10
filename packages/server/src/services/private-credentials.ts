/**
 * P6-15 (L14): private (per user) credentials, n8n's end-user credentials. A resolvable OAuth credential
 * keeps the shared fields on its row and one entry per user in `credential_user_entries` (binding
 * `{ tenantId, credentialId: '<id>:user:<userId>' }`, under RLS); a run uses the entry of its `endUserId`.
 * The hooks below are called from C0 lines in the S1 services (sharing, projects, transfer, member removal,
 * role change, publish), so no lane edits those files.
 * Stub from C0: `afterAccessChange`, `assertPublishable`, `assertMovable` and `assertProjectTransfer` PASS
 * (no private credential exists before L14); the entry methods throw until L14.
 */
import type { DataObject, WorkflowDefinition } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { CredentialUserEntryRow } from '../db/schema';
import type { AuthContext } from '../http/auth';

/** whose access changed: the entries of users who no longer reach a credential go */
export interface AccessChangeScope {
  userId?: string;
  projectId?: string;
  credentialId?: string;
}

/** a credential's connection state for the caller and in total */
export interface ConnectedStatus {
  connectedByMe: boolean;
  connectedCount: number;
}

export class PrivateCredentialService {
  constructor(readonly deps: ServiceDeps) {}

  async entry(
    _tenantId: string,
    _credentialId: string,
    _userId: string,
  ): Promise<CredentialUserEntryRow | undefined> {
    throw new Error('not implemented (L14)');
  }

  /** the OAuth callback of a per user flow writes the caller's entry (the session user must be the state's) */
  async saveEntry(
    _tenantId: string,
    _credentialId: string,
    _userId: string,
    _data: DataObject,
  ): Promise<void> {
    throw new Error('not implemented (L14)');
  }

  /** DELETE /credentials/:id/my-connection: the caller's own entry, also after the caller lost access */
  async deleteMine(_auth: AuthContext, _credentialId: string): Promise<void> {
    throw new Error('not implemented (L14)');
  }

  /** per credential id, for the list rows */
  async connectedStatus(
    _tenantId: string,
    _userId: string,
    _credentialIds: string[],
  ): Promise<Map<string, ConnectedStatus>> {
    throw new Error('not implemented (L14)');
  }

  /** after a role change, removal, unshare, move or team project delete. Stub (L14) PASSES */
  async afterAccessChange(_tenantId: string, _scope: AccessChangeScope): Promise<void> {
    // stub (L14): PASSES
  }

  /** a workflow using a private credential needs triggers that know the person. Stub (L14) PASSES */
  async assertPublishable(_tenantId: string, _definition: WorkflowDefinition): Promise<void> {
    // stub (L14): PASSES
  }

  /** a private credential never moves to a personal project; a move needs `credential:createEndUser`. PASSES */
  async assertMovable(_auth: AuthContext, _credentialId: string, _targetProjectId: string): Promise<void> {
    // stub (L14): PASSES
  }

  /** a project delete never migrates a private credential to a personal project. Stub (L14) PASSES */
  async assertProjectTransfer(
    _tenantId: string,
    _sourceProjectId: string,
    _targetProjectId: string,
  ): Promise<void> {
    // stub (L14): PASSES
  }
}
