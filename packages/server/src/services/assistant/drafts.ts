/**
 * Draft workflows the Assistant built (P5-70, lane L7). A draft lives on its thread (`putDraft`) until a
 * person accepts it (`workflows.create` or `workflows.update` with the draft's base version; a stale base
 * is 409 `The workflow changed. Build again or open it`) or discards it. No tool accepts a draft: only the
 * routes in routes/assistant-drafts.ts call `accept` and `discard`.
 *
 * Every read goes through the caller's own thread (tenant, user and thread id), so another user's or
 * another workspace's draft is 404. Accept checks the definition again on the server: the editor's
 * workflow shape, credentials of this workspace only, the validation, then the first credential of each
 * needed type for a node that has none. It writes an audit row, marks the draft accepted and sends a
 * `workflow` artifact on the thread.
 */
import {
  type AssistantDraftDTO,
  type AssistantDraftStatus,
  type DoctorIssue,
  diffWorkflows,
  nodeCredentialSlots,
  type WorkflowDefinition,
  type WorkflowDiff,
} from '@workflow/workflow';
import type { ServerContext, ServiceDeps } from '../../context';
import type { AssistantStoredDraft } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError, parse } from '../../http/errors';
import { workflowDataSchema } from '../../http/schemas';
import { validateDefinition } from '../ai-builder/tools';
import { assertCredentialsInTenant } from '../mcp/tools/builder/credential-check';
import { McpToolError } from '../mcp/workflow-gate';
import { cloneDefinition, toDefinition } from '../workflow-model';
import type { Actor } from '../workflows';

/** a credential Accept assigns to a node that has none (first of its type in the tenant) */
export interface AssistantDraftAssignment {
  nodeName: string;
  credentialType: string;
  credentialId: string;
  credentialName: string;
}

/** what GET `.../drafts/:draftId` returns: the draft, its diff against the saved workflow, the assignment */
export interface AssistantDraftView {
  draft: AssistantDraftDTO;
  diff: WorkflowDiff;
  assignments: AssistantDraftAssignment[];
}

/** the body of POST `.../accept` (L7 may add fields; nothing in it is trusted as a definition) */
export interface AssistantAcceptDraftBody {
  name?: string;
}

/** the texts a person sees from these routes */
export const ASSISTANT_DRAFT_TEXTS = {
  stale: 'The workflow changed. Build again or open it',
  notOpen: 'This draft is no longer open',
  busy: 'This draft is being saved already',
  invalid: 'The draft has errors, so it was not saved',
} as const;

/** validation codes that stop an Accept: the definition cannot be saved as it is */
const BLOCKING_CODES = new Set(['workflow-invalid', 'webhook-invalid', 'node-type-not-found']);

/** a stored draft's status (`open` when an older row has none) */
export function draftStatus(stored: AssistantStoredDraft): AssistantDraftStatus {
  const status = stored.status;
  return status === 'accepted' || status === 'discarded' ? status : 'open';
}

/** the client's view of a stored draft */
export function draftDto(stored: AssistantStoredDraft): AssistantDraftDTO {
  const definition = stored.definition;
  return {
    id: stored.id,
    name: stored.name,
    workflowId: stored.workflowId ?? null,
    baseVersionId: stored.baseVersionId ?? null,
    status: draftStatus(stored),
    definition,
    nodeCount: typeof stored.nodeCount === 'number' ? stored.nodeCount : (definition.nodes ?? []).length,
    issues: Array.isArray(stored.issues) ? (stored.issues as DoctorIssue[]) : [],
    createdAt: stored.createdAt,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : stored.createdAt,
  };
}

/**
 * For each node without credentials: the required credential slots it shows, each filled with the
 * workspace's first credential of that type (the oldest). A type the workspace has none of is skipped.
 */
export async function credentialAssignments(
  ctx: ServerContext,
  tenantId: string,
  definition: WorkflowDefinition,
): Promise<AssistantDraftAssignment[]> {
  const nodeTypes = ctx.registries.nodeTypes;
  const firstOfType = new Map<string, { id: string; name: string } | null>();
  const assignments: AssistantDraftAssignment[] = [];
  for (const node of definition.nodes ?? []) {
    if (node.credentials && Object.keys(node.credentials).length) continue;
    const description = nodeTypes.get(node.type)?.description;
    if (!description) continue;
    const slots = nodeCredentialSlots(
      description,
      (node.parameters ?? {}) as Record<string, unknown>,
      node.typeVersion,
    ).filter((slot) => slot.required === true);
    for (const slot of slots) {
      if (!firstOfType.has(slot.name)) {
        const rows = await ctx.repos.credentials.list(tenantId, slot.name);
        const first = [...rows].sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
        )[0];
        firstOfType.set(slot.name, first ? { id: first.id, name: first.name } : null);
      }
      const credential = firstOfType.get(slot.name);
      if (!credential) continue;
      assignments.push({
        nodeName: node.name,
        credentialType: slot.name,
        credentialId: credential.id,
        credentialName: credential.name,
      });
    }
  }
  return assignments;
}

const EMPTY: WorkflowDefinition = { name: '', nodes: [], connections: {} };

export class AssistantDrafts {
  /** drafts being accepted on this process: a second Accept of the same draft waits for nothing, it is refused */
  private readonly accepting = new Set<string>();

  constructor(readonly deps: ServiceDeps) {}

  private get ctx(): ServerContext {
    return this.deps.context();
  }

  /** the caller's thread and its stored draft; 404 for anything else */
  private async load(auth: AuthContext, threadId: string, draftId: string): Promise<AssistantStoredDraft> {
    const repo = this.deps.repos.assistantThreads;
    const thread = await repo.get(auth.tenant.id, auth.user.id, threadId);
    if (!thread) throw ApiError.notFound('Draft');
    const drafts = await repo.getDrafts(auth.tenant.id, thread.id);
    const stored = Object.hasOwn(drafts, draftId) ? drafts[draftId] : undefined;
    if (!stored || typeof stored !== 'object' || !stored.definition) throw ApiError.notFound('Draft');
    return stored;
  }

  /** the saved workflow the draft changes, as it is now (empty for a new workflow or one gone since) */
  private async baseOf(tenantId: string, stored: AssistantStoredDraft): Promise<WorkflowDefinition> {
    if (!stored.workflowId) return EMPTY;
    const row = await this.deps.repos.workflows.get(tenantId, stored.workflowId);
    return row ? toDefinition(row) : EMPTY;
  }

  /** the caller's draft on the caller's thread; 404 otherwise */
  async get(auth: AuthContext, threadId: string, draftId: string): Promise<AssistantDraftView> {
    const stored = await this.load(auth, threadId, draftId);
    const base = await this.baseOf(auth.tenant.id, stored);
    const assignments =
      draftStatus(stored) === 'open'
        ? await credentialAssignments(this.ctx, auth.tenant.id, stored.definition)
        : [];
    return { draft: draftDto(stored), diff: diffWorkflows(base, stored.definition), assignments };
  }

  /** stores (or replaces) a draft on the thread; `build_workflow` calls it */
  async put(tenantId: string, threadId: string, draft: AssistantStoredDraft): Promise<void> {
    await this.deps.repos.assistantThreads.putDraft(tenantId, threadId, draft.id, draft);
  }

  /** saves the draft as a workflow (a person only), audit row, `artifact` event through `assistant.publish` */
  async accept(
    auth: AuthContext,
    threadId: string,
    draftId: string,
    body: AssistantAcceptDraftBody,
    actor?: Actor,
  ): Promise<{ workflowId: string; draft: AssistantDraftDTO }> {
    const tenantId = auth.tenant.id;
    const key = `${tenantId}:${threadId}:${draftId}`;
    if (this.accepting.has(key)) throw ApiError.conflict(ASSISTANT_DRAFT_TEXTS.busy);
    this.accepting.add(key);
    try {
      const stored = await this.load(auth, threadId, draftId);
      if (draftStatus(stored) !== 'open') throw ApiError.conflict(ASSISTANT_DRAFT_TEXTS.notOpen);
      return await this.save(auth, threadId, stored, body, actor ?? { userId: auth.user.id });
    } finally {
      this.accepting.delete(key);
    }
  }

  private async save(
    auth: AuthContext,
    threadId: string,
    stored: AssistantStoredDraft,
    body: AssistantAcceptDraftBody,
    actor: Actor,
  ): Promise<{ workflowId: string; draft: AssistantDraftDTO }> {
    const ctx = this.ctx;
    const tenantId = auth.tenant.id;
    // the stored definition is checked again as if a client sent it: nothing in a draft is trusted
    const data = parse(workflowDataSchema, cloneDefinition(stored.definition));
    const definition = data as unknown as WorkflowDefinition;
    delete definition.staticData;
    const name = (body.name?.trim() || stored.name || definition.name || 'My workflow').slice(0, 128);
    definition.name = name;

    try {
      await assertCredentialsInTenant(ctx, tenantId, definition);
    } catch (error) {
      if (error instanceof McpToolError) throw ApiError.badRequest(error.message);
      throw error;
    }

    const assignments = await credentialAssignments(ctx, tenantId, definition);
    for (const assignment of assignments) {
      const node = definition.nodes.find((n) => n.name === assignment.nodeName);
      if (!node) continue;
      node.credentials = {
        ...(node.credentials ?? {}),
        [assignment.credentialType]: { id: assignment.credentialId, name: assignment.credentialName },
      };
    }

    const validation = await validateDefinition(ctx, tenantId, definition, stored.workflowId ?? undefined);
    const blocking = validation.issues.filter(
      (issue) => issue.severity === 'error' && issue.code && BLOCKING_CODES.has(issue.code),
    );
    if (blocking.length) {
      throw ApiError.badRequest(
        ASSISTANT_DRAFT_TEXTS.invalid,
        blocking.map((issue) => ({ node: issue.node, message: issue.message })),
      );
    }

    const input = {
      name,
      nodes: definition.nodes,
      connections: definition.connections ?? {},
      settings: definition.settings ?? {},
      pinData: definition.pinData ?? {},
      stickyNotes: definition.stickyNotes ?? [],
      nodeGroups: definition.nodeGroups ?? [],
    };
    let saved: { id: string; name: string; versionId: string };
    if (stored.workflowId) {
      if (!stored.baseVersionId) throw ApiError.conflict(ASSISTANT_DRAFT_TEXTS.stale);
      try {
        saved = await ctx.workflows.update(
          tenantId,
          stored.workflowId,
          { ...input, versionId: stored.baseVersionId } as unknown as Parameters<
            typeof ctx.workflows.update
          >[2],
          actor,
          'Saved from the Assistant',
        );
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 409) {
          throw ApiError.conflict(ASSISTANT_DRAFT_TEXTS.stale);
        }
        throw error;
      }
    } else {
      saved = await ctx.workflows.create(
        tenantId,
        { ...input, folderId: null } as unknown as Parameters<typeof ctx.workflows.create>[1],
        actor,
      );
    }

    await this.deps.repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'assistant.draft_accepted',
      resourceType: 'workflow',
      resourceId: saved.id,
      ip: actor.ip,
      metadata: { threadId, draftId: stored.id, created: !stored.workflowId },
    });

    const now = new Date().toISOString();
    const accepted: AssistantStoredDraft = {
      ...stored,
      name: saved.name,
      workflowId: saved.id,
      baseVersionId: saved.versionId,
      definition,
      status: 'accepted',
      nodeCount: definition.nodes.length,
      issues: validation.issues,
      updatedAt: now,
    };
    await this.put(tenantId, threadId, accepted);
    await ctx.assistant.publish(tenantId, threadId, {
      type: 'artifact',
      runId: null,
      payload: { artifact: { type: 'workflow', id: saved.id, name: saved.name } },
    });
    return { workflowId: saved.id, draft: draftDto(accepted) };
  }

  /** marks the draft discarded; nothing is saved */
  async discard(auth: AuthContext, threadId: string, draftId: string): Promise<void> {
    const stored = await this.load(auth, threadId, draftId);
    const status = draftStatus(stored);
    if (status === 'discarded') return;
    if (status === 'accepted') throw ApiError.conflict(ASSISTANT_DRAFT_TEXTS.notOpen);
    await this.put(auth.tenant.id, threadId, {
      ...stored,
      status: 'discarded',
      updatedAt: new Date().toISOString(),
    });
  }
}
