/**
 * The pre-run, save and publish credential check (P6-24): every credential a workflow's nodes name must be
 * usable by the workflow's project (owned by it, shared with it, global, or in `allow`, which comes from
 * server paths only, never from a node or a body). Called at run start (an inline sub-workflow with the
 * parent's project), at create, at a save with nodes and at publish (C0d). Error texts are n8n's
 * (credentials-permission-checker.ts). Deviation on purpose (Q23): no acting-user route and no
 * use-scope skip of n8n, so a member's own credential in a team workflow is refused until it is shared.
 */
import type { NodeCredentialRef, WorkflowDefinition } from '@workflow/workflow';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';

/** what the check reads (a `ServiceDeps` or any object with the repositories fits) */
export interface CredentialUsableDeps {
  repos: Repositories;
}

/** a node names a credential with no id, or one that does not exist (n8n's text) */
export class InvalidCredentialError extends ApiError {
  readonly description = 'Please recreate the credential.';

  constructor(readonly nodeName: string) {
    super(400, 'invalid_credential', `Node "${nodeName}" uses invalid credential`, {
      description: 'Please recreate the credential.',
    });
    this.name = 'InvalidCredentialError';
  }
}

/** a node names a credential the workflow's project cannot use (n8n's text) */
export class InaccessibleCredentialError extends ApiError {
  readonly description: string;

  constructor(
    readonly nodeName: string,
    project?: { type: 'personal' | 'team'; name: string },
  ) {
    const description =
      project?.type === 'team'
        ? `Please make sure that the credential is shared with the project "${project.name}"`
        : 'Please recreate the credential or ask its owner to share it with you.';
    super(400, 'inaccessible_credential', `Node "${nodeName}" does not have access to the credential`, {
      description,
    });
    this.description = description;
    this.name = 'InaccessibleCredentialError';
  }
}

/** one credential slot of one node, as the check reads it */
type CredentialUse =
  | { nodeName: string; kind: 'invalid' }
  | { nodeName: string; kind: 'id'; id: string }
  | { nodeName: string; kind: 'name'; name: string };

/** a credential id written as an expression: resolved at run time, where the provider checks it */
function isExpression(value: string): boolean {
  return value.startsWith('=');
}

/** the credential slots of the enabled nodes, in node order (n8n skips disabled nodes) */
function credentialUses(definition: WorkflowDefinition): CredentialUse[] {
  const uses: CredentialUse[] = [];
  for (const node of definition.nodes ?? []) {
    if (!node || node.disabled || node.credentials === undefined || node.credentials === null) continue;
    const nodeName = String(node.name);
    if (typeof node.credentials !== 'object' || Array.isArray(node.credentials)) {
      uses.push({ nodeName, kind: 'invalid' });
      continue;
    }
    for (const raw of Object.values(node.credentials as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        uses.push({ nodeName, kind: 'invalid' });
        continue;
      }
      const ref = raw as Partial<NodeCredentialRef>;
      if (typeof ref.id === 'string' && ref.id.trim() !== '') {
        if (!isExpression(ref.id.trim())) uses.push({ nodeName, kind: 'id', id: ref.id });
      } else if ((ref.id === null || ref.id === undefined || ref.id === '') && typeof ref.name === 'string') {
        // a reference by name: the provider looks it up inside the run's project only
        if (ref.name.trim() !== '') uses.push({ nodeName, kind: 'name', name: ref.name });
        else uses.push({ nodeName, kind: 'invalid' });
      } else {
        uses.push({ nodeName, kind: 'invalid' });
      }
    }
  }
  return uses;
}

/**
 * Throws `InvalidCredentialError` or `InaccessibleCredentialError` for the first node whose credential the
 * project cannot use: a ref that is not an object, or has neither an id nor a name, is invalid; a row owned
 * by another project, not shared with this one, not global and not in `allow` is inaccessible. A name-only
 * ref is refused when rows of that name exist but none is usable in the project (the provider looks names
 * up only there). An id or a name with no row at all, and an expression id, are left to the provider, which
 * fails the node when it runs (a pinned or simulated node never reads a credential).
 */
export async function assertCredentialsUsable(
  deps: CredentialUsableDeps,
  tenantId: string,
  projectId: string,
  definition: WorkflowDefinition,
  options?: { allow?: string[] },
): Promise<void> {
  const uses = credentialUses(definition);
  if (!uses.length) return;
  const { repos } = deps;
  const allow = new Set(options?.allow ?? []);
  const ids = uses.flatMap((use) => (use.kind === 'id' ? [use.id] : []));
  const rows = new Map((await repos.credentials.listByIds(tenantId, ids)).map((row) => [row.id, row]));
  const named = uses.some((use) => use.kind === 'name') ? await repos.credentials.list(tenantId) : [];
  const sharedHere = new Set(await repos.shares.credentialIdsSharedTo(tenantId, [projectId]));
  const usable = (row: { id: string; projectId: string; isGlobal: boolean }) =>
    allow.has(row.id) || row.projectId === projectId || row.isGlobal || sharedHere.has(row.id);

  let project: { type: 'personal' | 'team'; name: string } | undefined | null = null;
  const inaccessible = async (nodeName: string) => {
    if (project === null) {
      const row = await repos.projects.get(tenantId, projectId);
      project = row ? { type: row.type as 'personal' | 'team', name: row.name } : undefined;
    }
    return new InaccessibleCredentialError(nodeName, project);
  };

  for (const use of uses) {
    if (use.kind === 'invalid') throw new InvalidCredentialError(use.nodeName);
    if (use.kind === 'id') {
      // no row in the workspace (deleted, another workspace's, never made): nothing to reach; the provider
      // fails the node as "not found" if it runs (a pinned or simulated node never reads it)
      const row = rows.get(use.id);
      if (row && !usable(row)) throw await inaccessible(use.nodeName);
      continue;
    }
    const candidates = named.filter((row) => row.name === use.name);
    if (candidates.length && !candidates.some(usable)) throw await inaccessible(use.nodeName);
  }
}
