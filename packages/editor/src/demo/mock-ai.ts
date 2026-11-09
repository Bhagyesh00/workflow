/**
 * Demo AI workflow builder (P5-09, P5-62, lane L2): the builder's REST routes on the in-memory MockBackend and
 * the scripted chunks of a build turn. The demo has no model: install.ts sets a build stream connector
 * (`setBuildStreamConnector`) that plays `demoBuildChunks(body)` instead of `POST /ai/build`.
 *
 * Routes (the `aiApi` paths): the chat of a workflow per user (`/ai/sessions`), truncate, clear, the accepted
 * version and the admin's usage setting. State lives in `backend.ext.aiSessions` and `backend.ext.aiUsage`.
 * Scripts: a build (a new canvas gets Schedule Trigger -> HTTP Request -> Acme CRM; a canvas with nodes gets an
 * Edit Fields step after its last node), plan mode (questions, then a plan, then the build once approved) and a
 * message with a link (a web fetch approval, then the build with or without the page).
 */
import type {
  BuilderChunk,
  BuilderMessage,
  BuilderPlan,
  BuilderQuestion,
  BuildRequest,
  Connections,
  WorkflowNode,
} from '@workflow/workflow';
import type { AiSessionDTO, AiUsageSettingsBody } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';

interface DemoAiSession {
  tenantId: string;
  userId: string;
  workflowId: string;
  messages: BuilderMessage[];
  activeVersionCardId: string | null;
  resumeAfterRestoreMessageId: string | null;
}

function sessions(backend: MockBackend): DemoAiSession[] {
  backend.ext.aiSessions ??= [];
  return backend.ext.aiSessions as DemoAiSession[];
}

/** the caller's session of `workflowId` (the workflow must be in the caller's workspace, else 404) */
function sessionOf(backend: MockBackend, workflowId: unknown): DemoAiSession {
  if (typeof workflowId !== 'string' || !workflowId)
    throw new HttpError(400, 'bad_request', 'workflowId is required');
  const wf = backend.workflow(workflowId);
  const { user, tenant } = backend.requireScope('workflow:update', { scopes: backend.rowScopes(wf) });
  const list = sessions(backend);
  let session = list.find(
    (s) => s.tenantId === tenant.id && s.userId === user.id && s.workflowId === workflowId,
  );
  if (!session) {
    session = {
      tenantId: tenant.id,
      userId: user.id,
      workflowId,
      messages: [],
      activeVersionCardId: null,
      resumeAfterRestoreMessageId: null,
    };
    list.push(session);
  }
  return session;
}

function toDto(session: DemoAiSession): AiSessionDTO {
  return {
    workflowId: session.workflowId,
    messages: copy(session.messages),
    activeVersionCardId: session.activeVersionCardId,
    resumeAfterRestoreMessageId: session.resumeAfterRestoreMessageId,
  };
}

/** Puts `messages` in the signed-in user's chat of `workflowId` (demo data and tests). */
export function seedDemoAiSession(
  backend: MockBackend,
  workflowId: string,
  messages: BuilderMessage[],
): void {
  sessionOf(backend, workflowId).messages.push(...copy(messages));
}

/** The builder's REST routes (`aiApi`): chat history, truncate, clear, accepted version and the usage setting. */
export function registerAiRoutes(backend: MockBackend): void {
  backend.on('POST', '/ai/sessions', ({ body }) => toDto(sessionOf(backend, body.workflowId)));
  backend.on('POST', '/ai/build/truncate-messages', ({ body }) => {
    const session = sessionOf(backend, body.workflowId);
    const at = session.messages.findIndex((m) => m.id === body.messageId);
    if (at >= 0) session.messages = session.messages.slice(0, at);
    return { ok: true };
  });
  backend.on('POST', '/ai/build/clear-session', ({ body }) => {
    const session = sessionOf(backend, body.workflowId);
    session.messages = [];
    session.activeVersionCardId = null;
    session.resumeAfterRestoreMessageId = null;
    return { ok: true };
  });
  backend.on('POST', '/ai/build/accepted-version', ({ body }) => {
    const session = sessionOf(backend, body.workflowId);
    if (typeof body.versionId !== 'string' || !body.versionId) {
      throw new HttpError(400, 'bad_request', 'versionId is required');
    }
    const last = [...session.messages].reverse().find((m) => m.role === 'assistant');
    if (last) {
      last.versionId = body.versionId;
      session.activeVersionCardId = last.id;
    }
    return { ok: true };
  });
  backend.on('POST', '/ai/usage-settings', ({ body }): AiUsageSettingsBody => {
    const { tenant } = backend.requireScope('aiAssistant:manage');
    if (typeof body.allowSendingParameterValues !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'allowSendingParameterValues must be true or false');
    }
    backend.ext.aiUsage ??= {};
    (backend.ext.aiUsage as Record<string, boolean>)[tenant.id] = body.allowSendingParameterValues;
    return { allowSendingParameterValues: body.allowSendingParameterValues };
  });
}

// ---------------------------------------------------------------------------------------------
// Scripted turns
// ---------------------------------------------------------------------------------------------

const LINK = /https?:\/\/[^\s<>"')\]]+/i;

/** the editor's canvas as the request carries it (nothing is trusted to be there) */
function startNodes(body: BuildRequest): { nodes: WorkflowNode[]; connections: Connections; name: string } {
  const data = (body.workflowData ?? {}) as { nodes?: unknown; connections?: unknown; name?: unknown };
  return {
    nodes: Array.isArray(data.nodes) ? (copy(data.nodes) as WorkflowNode[]) : [],
    connections:
      data.connections && typeof data.connections === 'object' ? (copy(data.connections) as Connections) : {},
    name: typeof data.name === 'string' ? data.name : 'My workflow',
  };
}

/** a reply streamed in pieces, as the model's text arrives */
function say(text: string): BuilderChunk[] {
  const id = newId();
  const words = text.split(/(?<= )/);
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += 4) pieces.push(words.slice(i, i + 4).join(''));
  return pieces.map((piece): BuilderChunk => ({ type: 'message', id, text: piece, delta: true }));
}

function tool(toolName: string, summary?: string): BuilderChunk[] {
  return [
    { type: 'tool', toolName, status: 'running' },
    { type: 'tool', toolName, status: 'done', ...(summary ? { summary } : {}) },
  ];
}

const demoNode = (name: string, type: string, x: number, y: number, parameters: WorkflowNode['parameters']) =>
  ({ id: newId(), name, type, typeVersion: 1, position: [x, y], parameters }) as WorkflowNode;

/** one build: the draft of `body`'s canvas, as `workflow-updated` between the tool rows */
function buildTurn(body: BuildRequest, note?: string): BuilderChunk[] {
  const start = startNodes(body);
  const chunks: BuilderChunk[] = [
    ...(note ? say(note) : []),
    ...tool('search_nodes', 'Found the nodes to use'),
  ];
  if (!start.nodes.length) {
    const trigger = demoNode('Schedule Trigger', 'core.scheduleTrigger', 0, 0, {
      rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
    });
    const fetchLeads = demoNode('Get new leads', 'core.httpRequest', 260, 0, {
      method: 'GET',
      url: 'https://api.example.com/leads',
    });
    const crm = demoNode('Add contact', 'app.crm', 520, 0, {
      resource: 'contact',
      operation: 'create',
      email: '={{ $json.email }}',
    });
    const nodes = [trigger, fetchLeads, crm];
    const connections: Connections = {
      [trigger.name]: { main: [[{ node: fetchLeads.name, type: 'main', index: 0 }]] },
      [fetchLeads.name]: { main: [[{ node: crm.name, type: 'main', index: 0 }]] },
    };
    chunks.push(
      { type: 'tool', toolName: 'add_nodes', status: 'running' },
      { type: 'workflow-updated', workflow: { name: start.name, nodes, connections: {} } },
      { type: 'tool', toolName: 'add_nodes', status: 'done', summary: 'Added 3 nodes' },
      { type: 'tool', toolName: 'connect_nodes', status: 'running' },
      { type: 'workflow-updated', workflow: { name: start.name, nodes, connections } },
      { type: 'tool', toolName: 'connect_nodes', status: 'done', summary: 'Connected 2 nodes' },
      ...tool('validate_workflow', 'No problems found'),
      ...say(
        'I drafted the workflow: every hour **Get new leads** calls your leads API and **Add contact** creates a ' +
          'contact in Acme CRM for each lead. Check the URL in the review, then Accept or Discard.',
      ),
    );
    return chunks;
  }
  const taken = new Set(start.nodes.map((n) => n.name));
  const hasOutgoing = new Set(Object.keys(start.connections));
  const last =
    [...start.nodes].reverse().find((n) => !hasOutgoing.has(n.name)) ?? start.nodes[start.nodes.length - 1];
  let name = 'Mark as processed';
  for (let i = 2; taken.has(name); i++) name = `Mark as processed ${i}`;
  const x = Math.max(...start.nodes.map((n) => (Array.isArray(n.position) ? n.position[0] : 0))) + 260;
  const step = demoNode(name, 'core.set', x, Array.isArray(last.position) ? last.position[1] : 0, {
    mode: 'manual',
    assignments: { assignments: [{ id: newId(), name: 'processed', value: true, type: 'boolean' }] },
  });
  const nodes = [...start.nodes, step];
  const outputs = start.connections[last.name]?.main ?? [];
  const connections: Connections = {
    ...start.connections,
    [last.name]: {
      ...start.connections[last.name],
      main: [[...(outputs[0] ?? []), { node: step.name, type: 'main', index: 0 }], ...outputs.slice(1)],
    },
  };
  chunks.push(
    { type: 'tool', toolName: 'add_nodes', status: 'running' },
    { type: 'workflow-updated', workflow: { name: start.name, nodes, connections } },
    { type: 'tool', toolName: 'add_nodes', status: 'done', summary: `Added ${step.name}` },
    ...tool('validate_workflow', 'No problems found'),
    ...say(`I added **${step.name}** after **${last.name}**: it marks each item as processed.`),
  );
  return chunks;
}

const DEMO_QUESTIONS: BuilderQuestion[] = [
  {
    id: 'trigger',
    question: 'When should the workflow run?',
    type: 'single',
    options: ['Every hour', 'When a webhook is called', 'When I start it'],
  },
  { id: 'target', question: 'Where should the results go?', type: 'text' },
];

function demoPlan(feedback?: string): BuilderPlan {
  return {
    summary: feedback ? `Leads to CRM, changed: ${feedback}` : 'Copy new leads into the CRM every hour',
    trigger: 'Schedule Trigger, every hour',
    steps: [
      {
        description: 'Get the leads created in the last hour from the leads API',
        nodeTypes: ['core.httpRequest'],
      },
      { description: 'Create a contact in Acme CRM for each lead', nodeTypes: ['app.crm'] },
    ],
    notes: ['The CRM credential is picked from your credentials when the draft lands.'],
  };
}

/** The chunks one demo build turn streams for `body` (what the server's NDJSON would carry). */
export function demoBuildChunks(body: BuildRequest): BuilderChunk[] {
  const resume = body.resumeData;
  if (resume && 'webFetch' in resume) {
    const { url, decision } = resume.webFetch;
    if (decision === 'deny')
      return buildTurn(body, "I won't read the page and will build from your message. ");
    let domain = url;
    try {
      domain = new URL(url).hostname;
    } catch {
      // the URL the user approved is shown as it is
    }
    return [...tool('web_fetch', `Read ${domain}`), ...buildTurn(body)];
  }
  if (resume && 'answers' in resume) {
    return [
      ...tool('search_nodes', 'Found the nodes to use'),
      { type: 'plan', plan: demoPlan() },
      ...say('Here is the plan. Approve it to build, or tell me what to change.'),
    ];
  }
  if (resume && 'planDecision' in resume) {
    if (resume.planDecision === 'approve') return buildTurn(body, 'Building the approved plan. ');
    if (resume.planDecision === 'modify') {
      return [
        { type: 'plan', plan: demoPlan(resume.feedback?.trim() || 'your notes') },
        ...say('I updated the plan.'),
      ];
    }
    return say('I dropped the plan. Tell me what you want instead.');
  }
  if (body.mode === 'plan') {
    return [
      ...say('A few questions before I plan. '),
      { type: 'questions', questions: copy(DEMO_QUESTIONS) },
    ];
  }
  const link = LINK.exec(body.text)?.[0];
  if (link) {
    let domain = link;
    try {
      domain = new URL(link).hostname;
    } catch {
      // not a URL after all: the page is shown as written
    }
    return [
      ...say(`I'd like to read ${link} to see how its API works. `),
      { type: 'web-fetch-approval', url: link, domain },
    ];
  }
  return buildTurn(body);
}
