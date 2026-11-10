/**
 * P6-15 (L14): private (per user) credentials, n8n's end-user credentials. A resolvable OAuth credential
 * keeps the shared fields on its row and one entry per user in `credential_user_entries` (binding
 * `{ tenantId, credentialId: '<id>:user:<userId>' }`, under RLS); a run uses the entry of its `endUserId`
 * (`CredentialService.provider`). The hooks below are called from C0 lines in the S1 services (sharing,
 * projects, transfer, member removal, role change, publish), so no lane edits those files.
 */
import {
  type DataObject,
  IDENTITY_TRIGGERS_TEXT,
  isTriggerDescription,
  type NodeCredentialRef,
  triggerProvidesIdentity,
  type WorkflowDefinition,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { CredentialUserEntryRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { isUuid } from '../repositories/util';
import { MISSING_SCOPE_MESSAGE } from './access';

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

/** only these types can be private (n8n: the OAuth ones) */
export const PRIVATE_TYPE_ERROR = 'Only OAuth1 and OAuth2 credentials can be private';
/** n8n refuses a resolvable credential in a personal project (create, switch, move, project delete) */
export const PRIVATE_PERSONAL_ERROR = "Private credentials can't be used in a personal project";
export const PRIVATE_MOVE_PERSONAL_ERROR = "A private credential can't be moved to a personal project";

/** n8n's publish refusal for a workflow whose private credentials meet a trigger that knows no user */
export function privatePublishError(names: string[]): string {
  return `Cannot publish workflow: end-user credentials (${names.join(', ')}) are only supported with ${IDENTITY_TRIGGERS_TEXT}`;
}

/** the scope a member needs on a credential to keep (or make) their own connection */
const KEEP_SCOPE = 'credential:connect';

export class PrivateCredentialService {
  constructor(readonly deps: ServiceDeps) {}

  async entry(tenantId: string, credentialId: string, userId: string): Promise<CredentialUserEntryRow | undefined> {
    return this.deps.repos.credentialEntries.get(tenantId, credentialId, userId);
  }

  /** the OAuth callback of a per user flow writes the caller's entry (the session user must be the state's) */
  async saveEntry(tenantId: string, credentialId: string, userId: string, data: DataObject): Promise<void> {
    await this.deps.context().credentials.saveEntry(tenantId, credentialId, userId, data);
  }

  /** DELETE /credentials/:id/my-connection: the caller's own entry, also after the caller lost access */
  async deleteMine(auth: AuthContext, credentialId: string): Promise<void> {
    const tenantId = auth.tenant.id;
    const { repos } = this.deps;
    if (!isUuid(credentialId) || !(await repos.credentials.get(tenantId, credentialId))) {
      throw ApiError.notFound('Credential');
    }
    if (await repos.credentialEntries.delete(tenantId, credentialId, auth.user.id)) {
      await repos.audit.add(tenantId, {
        userId: auth.user.id,
        action: 'credential.user_disconnected',
        resourceType: 'credential',
        resourceId: credentialId,
      });
    }
  }

  /** per credential id, for the list rows */
  async connectedStatus(
    tenantId: string,
    userId: string,
    credentialIds: string[],
  ): Promise<Map<string, ConnectedStatus>> {
    const { credentialEntries } = this.deps.repos;
    const mine = await credentialEntries.connectedIds(tenantId, userId, credentialIds);
    const counts = await credentialEntries.countByCredential(tenantId, credentialIds);
    const out = new Map<string, ConnectedStatus>();
    for (const id of credentialIds) {
      out.set(id, { connectedByMe: mine.has(id), connectedCount: counts.get(id) ?? 0 });
    }
    return out;
  }

  /**
   * The type and project rules of a private credential (create and the switch to private): an OAuth type,
   * never in a personal project. `credential:createEndUser` is the route's check.
   */
  async assertCanBePrivate(tenantId: string, type: string, projectId: string): Promise<void> {
    const { credentials } = this.deps.context();
    if (!credentials.isOAuthType(type)) throw ApiError.badRequest(PRIVATE_TYPE_ERROR);
    const project = await this.deps.repos.projects.get(tenantId, projectId);
    if (project?.type === 'personal') throw ApiError.badRequest(PRIVATE_PERSONAL_ERROR);
  }

  /**
   * After a role change, removal, unshare, move or team project delete (n8n's connection status service):
   * every entry in the scope whose user no longer holds `credential:connect` on its credential goes. A
   * project-only scope (a project delete) checks every entry of the workspace, since the project's shares
   * are already gone.
   */
  async afterAccessChange(tenantId: string, scope: AccessChangeScope): Promise<void> {
    const { repos } = this.deps;
    const { access } = this.deps.context();
    const entries = await repos.credentialEntries.list(tenantId, {
      ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      ...(scope.credentialId !== undefined ? { credentialId: scope.credentialId } : {}),
    });
    for (const { credentialId, userId } of entries) {
      let keep = false;
      try {
        keep = (await access.scopesFor(tenantId, userId, { credentialId })).has(KEEP_SCOPE);
      } catch (error) {
        // the credential is gone (its entries went with it); anything else is a real failure
        if (!(error instanceof ApiError && error.statusCode === 404)) throw error;
      }
      if (!keep) await repos.credentialEntries.delete(tenantId, credentialId, userId);
    }
  }

  /**
   * A workflow using a private credential publishes only when every enabled trigger starts its runs as a
   * known user (`triggerProvidesIdentity`), n8n's workflow validation. Disabled nodes do not count.
   */
  async assertPublishable(tenantId: string, definition: WorkflowDefinition): Promise<void> {
    const { repos } = this.deps;
    const nodes = (definition.nodes ?? []).filter((node) => node && !node.disabled);
    const ids: string[] = [];
    const names: string[] = [];
    for (const node of nodes) {
      if (!node.credentials || typeof node.credentials !== 'object') continue;
      for (const raw of Object.values(node.credentials as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const ref = raw as Partial<NodeCredentialRef>;
        if (typeof ref.id === 'string' && ref.id !== '') ids.push(ref.id);
        else if (typeof ref.name === 'string' && ref.name !== '') names.push(ref.name);
      }
    }
    if (!ids.length && !names.length) return;
    const privateIds = await repos.credentialEntries.resolvableIds(tenantId, ids);
    const used = new Set<string>();
    for (const id of privateIds) {
      const row = await repos.credentials.get(tenantId, id);
      if (row) used.add(row.name);
    }
    for (const row of await repos.credentialEntries.resolvableByName(tenantId, names)) used.add(row.name);
    if (!used.size) return;
    const { nodeTypes } = this.deps.context().registries;
    const blocked = nodes.some(
      (node) =>
        isTriggerDescription(nodeTypes.get(node.type)?.description) &&
        !triggerProvidesIdentity(node.type, node.parameters as DataObject | undefined),
    );
    if (blocked) throw ApiError.badRequest(privatePublishError([...used].sort()));
  }

  /** a private credential never moves to a personal project; a move needs `credential:createEndUser` */
  async assertMovable(auth: AuthContext, credentialId: string, targetProjectId: string): Promise<void> {
    const tenantId = auth.tenant.id;
    const row = await this.deps.repos.credentials.get(tenantId, credentialId);
    // a missing credential is the transfer's own 404
    if (!row?.isResolvable) return;
    const scopes = await this.deps.context().access.scopesForAuth(auth, { credentialId });
    if (!scopes.has('credential:createEndUser')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const target = await this.deps.repos.projects.get(tenantId, targetProjectId);
    if (target?.type === 'personal') throw ApiError.badRequest(PRIVATE_MOVE_PERSONAL_ERROR);
  }

  /** a project delete never migrates a private credential to a personal project (n8n's project service) */
  async assertProjectTransfer(tenantId: string, sourceProjectId: string, targetProjectId: string): Promise<void> {
    const { repos } = this.deps;
    const target = await repos.projects.get(tenantId, targetProjectId);
    if (target?.type !== 'personal') return;
    const owned = await repos.credentialEntries.resolvableInProject(tenantId, sourceProjectId);
    if (!owned.length) return;
    throw ApiError.badRequest(
      `Can't delete project. Private credentials can't be moved to a personal project: ${owned
        .map((row) => row.name)
        .sort()
        .join(', ')}`,
    );
  }
}
