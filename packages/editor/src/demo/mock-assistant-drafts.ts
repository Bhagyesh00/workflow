/**
 * Demo Assistant drafts (P5-70, lane L7): GET `/assistant/threads/:threadId/drafts/:draftId`, POST `.../accept` and
 * POST `.../discard` (`assistantApi.draft`, `acceptDraft`, `discardDraft`) on the in-memory MockBackend.
 *
 * As the server: a draft is read through the signed-in user's own thread in this workspace (else 404); Accept and
 * Discard need an editor (403); only an open draft is accepted (409); Accept of a draft of a saved workflow needs
 * the version it was built on (409 `The workflow changed. Build again or open it`), saves the workflow, marks the
 * draft accepted and plays a `workflow` artifact on the thread. `addDemoDraft` puts a draft on a demo thread with
 * its `artifact` event, for demo scripts and tests.
 */
import {
  type AssistantDraftDTO,
  type Connections,
  diffWorkflows,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { AssistantDraftView } from '../api/types';
import { newId } from '../lib/ids';
import { assistantDemoState, type DemoAssistantThread, publishAssistantDemoEvent } from './mock-assistant';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

/** the server's texts */
const STALE = 'The workflow changed. Build again or open it';
const NOT_OPEN = 'This draft is no longer open';

/** the drafts of each demo backend, by thread then draft id */
const store = new WeakMap<MockBackend, Map<string, Map<string, AssistantDraftDTO>>>();

function draftsOf(backend: MockBackend, threadId: string): Map<string, AssistantDraftDTO> {
  let threads = store.get(backend);
  if (!threads) {
    threads = new Map();
    store.set(backend, threads);
  }
  let drafts = threads.get(threadId);
  if (!drafts) {
    drafts = new Map();
    threads.set(threadId, drafts);
  }
  return drafts;
}

/** the signed-in user's own thread in this workspace */
function ownThread(backend: MockBackend, threadId: string): DemoAssistantThread {
  const { user, tenant } = backend.auth();
  const thread = assistantDemoState(backend).threads.get(threadId);
  if (!thread || thread.userId !== user.id || thread.tenantId !== tenant.id) {
    throw new HttpError(404, 'not_found', 'Draft not found');
  }
  return thread;
}

function ownDraft(backend: MockBackend, threadId: string, draftId: string): AssistantDraftDTO {
  ownThread(backend, threadId);
  const draft = draftsOf(backend, threadId).get(draftId);
  if (!draft) throw new HttpError(404, 'not_found', 'Draft not found');
  return draft;
}

const EMPTY: WorkflowDefinition = { name: '', nodes: [], connections: {} };

function baseOf(backend: MockBackend, draft: AssistantDraftDTO): WorkflowDefinition {
  if (!draft.workflowId) return EMPTY;
  const { tenant } = backend.auth();
  const wf = backend.workflows.find((w) => w.id === draft.workflowId && w.tenantId === tenant.id);
  if (!wf) return EMPTY;
  return { id: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
}

function view(backend: MockBackend, draft: AssistantDraftDTO): AssistantDraftView {
  return {
    draft: copy(draft),
    diff: diffWorkflows(baseOf(backend, draft), draft.definition),
    assignments: [],
  };
}

/** saves the draft's definition: a new workflow, or the saved one when its version is still the draft's base */
function save(backend: MockBackend, draft: AssistantDraftDTO, name: string): StoredWorkflow {
  const { tenant } = backend.auth();
  const definition = copy(draft.definition);
  if (draft.workflowId) {
    const wf = backend.workflow(draft.workflowId);
    if (wf.versionId !== draft.baseVersionId) throw new HttpError(409, 'conflict', STALE);
    wf.name = name;
    wf.nodes = definition.nodes as WorkflowNode[];
    wf.connections = (definition.connections ?? {}) as Connections;
    wf.settings = definition.settings ?? {};
    wf.versionId = newId();
    wf.updatedAt = now();
    backend.recordVersion(wf, 'Saved from the Assistant');
    return wf;
  }
  const wf: StoredWorkflow = {
    id: newId(),
    tenantId: tenant.id,
    name,
    nodes: definition.nodes as WorkflowNode[],
    connections: (definition.connections ?? {}) as Connections,
    settings: definition.settings ?? {},
    pinData: {},
    stickyNotes: definition.stickyNotes ?? [],
    active: false,
    versionId: newId(),
    tags: [],
    createdAt: now(),
    updatedAt: now(),
    nodeGroups: definition.nodeGroups ?? [],
    folderId: null,
    isArchived: false,
    publishedVersionId: null,
  };
  backend.workflows.push(wf);
  backend.recordVersion(wf, null);
  return wf;
}

/** puts a draft on a demo thread of its owner and plays its `artifact` event; returns the draft as stored */
export function addDemoDraft(
  backend: MockBackend,
  threadId: string,
  draft: AssistantDraftDTO,
): AssistantDraftDTO {
  if (!assistantDemoState(backend).threads.has(threadId)) {
    throw new HttpError(404, 'not_found', 'Thread not found');
  }
  const stored = copy(draft);
  draftsOf(backend, threadId).set(stored.id, stored);
  publishAssistantDemoEvent(backend, threadId, 'artifact', {
    artifact: { type: 'draft', draftId: stored.id, name: stored.name },
  });
  return copy(stored);
}

/** P5-70: registers the demo draft routes (L7) */
export function registerAssistantDraftRoutes(backend: MockBackend): void {
  backend.on('GET', '/assistant/threads/:threadId/drafts/:draftId', ({ params }) =>
    view(backend, ownDraft(backend, params[0], params[1])),
  );

  backend.on('POST', '/assistant/threads/:threadId/drafts/:draftId/accept', ({ params, body }) => {
    backend.requireRole('editor');
    const [threadId, draftId] = params;
    const draft = ownDraft(backend, threadId, draftId);
    if (draft.status !== 'open') throw new HttpError(409, 'conflict', NOT_OPEN);
    if (typeof body.updatedAt === 'string' && body.updatedAt !== draft.updatedAt) {
      throw new HttpError(409, 'conflict', 'The draft changed. Review it again');
    }
    const given = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : '';
    const wf = save(backend, draft, given || draft.name);
    draft.status = 'accepted';
    draft.name = wf.name;
    draft.workflowId = wf.id;
    draft.baseVersionId = wf.versionId;
    draft.updatedAt = now();
    publishAssistantDemoEvent(backend, threadId, 'artifact', {
      artifact: { type: 'workflow', id: wf.id, name: wf.name },
    });
    return { workflowId: wf.id, draft: copy(draft) };
  });

  backend.on('POST', '/assistant/threads/:threadId/drafts/:draftId/discard', ({ params }) => {
    backend.requireRole('editor');
    const draft = ownDraft(backend, params[0], params[1]);
    if (draft.status === 'accepted') throw new HttpError(409, 'conflict', NOT_OPEN);
    draft.status = 'discarded';
    draft.updatedAt = now();
    return { ok: true };
  });
}
