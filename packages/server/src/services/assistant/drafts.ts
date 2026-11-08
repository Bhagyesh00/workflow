/**
 * Draft workflows the Assistant built (P5-70, lane L7). A draft lives on its thread (`putDraft`) until a
 * person accepts it (`workflows.create` or `workflows.update` with the draft's base version; a stale base
 * is 409 `The workflow changed. Build again or open it`) or discards it. No tool accepts a draft. C0 stub
 * with the final signatures; the constructor does not throw.
 */
import type { AssistantDraftDTO, WorkflowDiff } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AssistantStoredDraft } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
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

export class AssistantDrafts {
  constructor(readonly deps: ServiceDeps) {}

  /** the caller's draft on the caller's thread; 404 otherwise */
  async get(_auth: AuthContext, _threadId: string, _draftId: string): Promise<AssistantDraftView> {
    throw new Error('not implemented (L7)');
  }

  /** stores (or replaces) a draft on the thread; `build_workflow` calls it */
  async put(_tenantId: string, _threadId: string, _draft: AssistantStoredDraft): Promise<void> {
    throw new Error('not implemented (L7)');
  }

  /** saves the draft as a workflow (a person only), audit row, `artifact` event through `assistant.publish` */
  async accept(
    _auth: AuthContext,
    _threadId: string,
    _draftId: string,
    _body: AssistantAcceptDraftBody,
    _actor?: Actor,
  ): Promise<{ workflowId: string; draft: AssistantDraftDTO }> {
    throw new Error('not implemented (L7)');
  }

  /** marks the draft discarded; nothing is saved */
  async discard(_auth: AuthContext, _threadId: string, _draftId: string): Promise<void> {
    throw new Error('not implemented (L7)');
  }
}
