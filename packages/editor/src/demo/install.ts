/**
 * Demo mode (`vite build --mode demo`): the real editor UI backed by the in-memory MockBackend,
 * so the product can be reviewed in any browser without running the server. Data lives in the
 * page and resets on reload.
 */
import { type BuildStreamConnector, setBuildStreamConnector } from '../api/ai-stream';
import { setChatFetch } from '../api/chat-transport';
import { setTransport } from '../api/client';
import { setPushConnector } from '../api/push';
import { demoGroupedWorkflow } from './fixtures';
import { demoBuildChunks } from './mock-ai';
import { MockBackend } from './mock-backend';
import { demoChatFetch } from './mock-chat';

/** pause between two scripted builder chunks, so the demo panel shows progress as a stream would */
const DEMO_BUILD_CHUNK_MS = 300;

/** what an aborted fetch rejects with: the signal's reason (an AbortError unless the caller gave one) */
function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The build was stopped', 'AbortError');
}

/**
 * P5-09: the demo's builder turn. No model and no server: it plays mock-ai's scripted chunks for the request,
 * one every DEMO_BUILD_CHUNK_MS, and rejects like an aborted fetch when `signal` aborts (Stop, Discard, reset).
 */
export const demoBuildStream: BuildStreamConnector = async (body, onChunk, signal) => {
  for (const chunk of demoBuildChunks(body)) {
    if (signal.aborted) throw aborted(signal);
    await new Promise((resolve) => setTimeout(resolve, DEMO_BUILD_CHUNK_MS));
    if (signal.aborted) throw aborted(signal);
    onChunk(chunk);
  }
};

export function seedDemo(backend: MockBackend): void {
  backend.createAccount({
    email: 'demo@example.com',
    password: 'demo-pass-1',
    name: 'Dana Demo',
    workspaceName: 'Acme Operations',
  });
  backend.createAccount({
    email: 'ops@example.com',
    password: 'demo-pass-1',
    name: 'Ops Bot',
    workspaceName: 'Acme Labs',
  });
  backend.signIn('demo@example.com');
  const tenantId = backend.session!.tenantId;
  const ops = backend.users.find((u) => u.email === 'ops@example.com')!;
  backend.memberships.push({ tenantId, userId: ops.id, role: 'editor' });
  const labs = backend.tenants.find((t) => t.name === 'Acme Labs')!;
  backend.memberships.push({ tenantId: labs.id, userId: backend.session!.userId, role: 'admin' });

  backend.tags.push({ id: 'tag-orders', name: 'orders', tenantId }, { id: 'tag-ai', name: 'ai', tenantId });
  backend.variables.push({ id: 'var-1', key: 'region', value: 'eu-central', tenantId });
  backend.credentials.push({
    id: 'cred-crm',
    tenantId,
    name: 'Acme CRM (production)',
    type: 'crmApi',
    data: { apiKey: 'demo-secret', region: 'eu' },
    createdAt: new Date(Date.now() - 86_400_000 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  });

  backend.seedWorkflow({
    name: 'Order intake',
    tags: [{ id: 'tag-orders', name: 'orders' }],
    nodes: [
      {
        id: 'n-webhook',
        name: 'New order',
        type: 'core.webhook',
        typeVersion: 1,
        position: [0, 0],
        parameters: { httpMethod: 'POST', path: 'orders/new' },
        webhookId: 'w-1',
      },
      {
        id: 'n-manual',
        name: 'Try it',
        type: 'core.manualTrigger',
        typeVersion: 1,
        position: [0, 200],
        parameters: {},
      },
      {
        id: 'n-set',
        name: 'Shape order',
        type: 'core.set',
        typeVersion: 1,
        position: [300, 100],
        parameters: {
          mode: 'manual',
          includeOtherFields: false,
          assignments: {
            assignments: [
              { id: 'a1', name: 'orderId', type: 'number', value: '={{ $json.body?.orderId ?? 1001 }}' },
              {
                id: 'a2',
                name: 'customer',
                type: 'string',
                value: '={{ $json.body?.customer?.name ?? "Theo Lindqvist" }}',
              },
              { id: 'a3', name: 'total', type: 'number', value: '={{ $json.body?.total ?? 250 }}' },
              { id: 'a4', name: 'region', type: 'string', value: '={{ $vars.region }}' },
            ],
          },
        },
      },
      {
        id: 'n-if',
        name: 'Large order?',
        type: 'core.if',
        typeVersion: 1,
        position: [600, 100],
        parameters: {
          conditions: {
            combinator: 'and',
            conditions: [
              {
                id: 'c1',
                leftValue: '={{ $json.total }}',
                rightValue: '100',
                operator: { type: 'number', operation: 'gt' },
              },
            ],
            options: { caseSensitive: true, typeValidation: 'strict' },
          },
        },
      },
      {
        id: 'n-crm',
        name: 'Find customer',
        type: 'app.crm',
        typeVersion: 1,
        position: [900, 0],
        parameters: {
          resource: 'contact',
          operation: 'get',
          contactId: { __rl: true, mode: 'list', value: 'c_100', cachedResultName: 'Mara Quinn' },
        },
        credentials: { crmApi: { id: 'cred-crm', name: 'Acme CRM (production)' } },
      },
      {
        id: 'n-noop',
        name: 'Small order',
        type: 'core.noOp',
        typeVersion: 1,
        position: [900, 220],
        parameters: {},
      },
      {
        id: 'n-code',
        name: 'Log result',
        type: 'core.code',
        typeVersion: 1,
        position: [1200, 0],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: "console.log('customers', $input.all().length);\nreturn $input.all();\n",
        },
      },
    ],
    connections: {
      'New order': { main: [[{ node: 'Shape order', type: 'main', index: 0 }]] },
      'Try it': { main: [[{ node: 'Shape order', type: 'main', index: 0 }]] },
      'Shape order': { main: [[{ node: 'Large order?', type: 'main', index: 0 }]] },
      'Large order?': {
        main: [
          [{ node: 'Find customer', type: 'main', index: 0 }],
          [{ node: 'Small order', type: 'main', index: 0 }],
        ],
      },
      'Find customer': { main: [[{ node: 'Log result', type: 'main', index: 0 }]] },
    },
    stickyNotes: [
      {
        id: 's-1',
        content:
          '## Order intake\nOrders arrive on the **webhook**. Large ones are matched to a CRM contact.\n\nClick **Execute workflow** to try it with sample data.',
        position: [-40, -230],
        width: 340,
        height: 170,
        color: '#56ccf2',
      },
    ],
  });

  backend.seedWorkflow({
    name: 'Support assistant',
    active: false,
    tags: [{ id: 'tag-ai', name: 'ai' }],
    nodes: [
      {
        id: 'm-1',
        name: 'Try it',
        type: 'core.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'm-2',
        name: 'Question',
        type: 'core.set',
        typeVersion: 1,
        position: [280, 0],
        parameters: {
          mode: 'manual',
          includeOtherFields: false,
          assignments: {
            assignments: [{ id: 'q', name: 'question', type: 'string', value: 'Where is my order 1042?' }],
          },
        },
      },
      {
        id: 'm-3',
        name: 'AI Agent',
        type: 'ai.agent',
        typeVersion: 1,
        position: [560, -10],
        parameters: { text: '={{ $json.question }}' },
      },
      {
        id: 'm-4',
        name: 'Chat Model',
        type: 'ai.lmChatDemo',
        typeVersion: 1,
        position: [520, 220],
        parameters: { model: 'fast' },
      },
      {
        id: 'm-5',
        name: 'Window Memory',
        type: 'ai.memoryBuffer',
        typeVersion: 1,
        position: [660, 220],
        parameters: {},
      },
      {
        id: 'm-6',
        name: 'Calculator',
        type: 'ai.toolCalculator',
        typeVersion: 1,
        position: [800, 220],
        parameters: {},
      },
    ],
    connections: {
      'Try it': { main: [[{ node: 'Question', type: 'main', index: 0 }]] },
      Question: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
      'Chat Model': { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] },
      'Window Memory': { ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]] },
      Calculator: { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
    },
  });

  backend.seedWorkflow({
    name: demoGroupedWorkflow.name,
    nodes: demoGroupedWorkflow.nodes,
    connections: demoGroupedWorkflow.connections,
    nodeGroups: demoGroupedWorkflow.nodeGroups,
  });
}

export function installDemo(): MockBackend {
  const backend = new MockBackend({
    stepDelayMs: 450,
    autoWebhookMs: 2500,
    brand: { name: 'Workflow', logoUrl: null, primaryColor: '#3346d3' },
  });
  seedDemo(backend);
  setTransport((request) => backend.handle(request));
  // S3: the canvas chat panel posts to test chat URLs through this fetch (no server in the demo)
  setChatFetch(demoChatFetch(backend));
  // S4: the AI builder's turns play scripted chunks (mock-ai) instead of POST /ai/build
  setBuildStreamConnector(demoBuildStream);
  setPushConnector((onEvent, onStatus) => {
    onStatus('open');
    const unsubscribe = backend.subscribe(onEvent);
    return { close: unsubscribe };
  });
  return backend;
}
