/**
 * Demo chat (P5-59, lane L5): the canvas chat panel's transport on the in-memory MockBackend.
 *
 * `demoChatFetch` answers the panel's POSTs to a test chat URL (`/webhook-test/<slug>/<id>/chat` with the
 * `x-chat-test-token` header that POST /workflows/:id/listen-test-webhook returned): it finds the listen by
 * its token (`backend.testListenByChatToken`), starts the simulated run with the chat item
 * (`backend.receiveTestWebhook(workflowId, [item])`, which also emits `testWebhookReceived`) and answers with
 * NDJSON frames (`ChatFrame` of @workflow/workflow) when the trigger streams, else with `{ output }`.
 * install.ts passes it to `setChatFetch`. The reply is a scripted one: the message of each Respond to Chat
 * node, else an echo of what was asked.
 */
import { CHAT_TEST_HEADER, type ChatFrame, type ChatFrameMetadata, type Item } from '@workflow/workflow';
import type { MockBackend, StoredWorkflow } from './mock-backend';

/** Routes the demo chat needs on the REST transport: none (the panel posts to the test URL itself). */
export function registerChatRoutes(_backend: MockBackend): void {
  // the chat POST goes through demoChatFetch, not through the REST transport
}

const NDJSON = 'application/x-ndjson';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (!headers) return '';
  if (headers instanceof Headers) return headers.get(name) ?? '';
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found ? found[1] : '';
  }
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return String(value);
  return '';
}

interface ChatBody {
  chatInput: string;
  sessionId: string;
}

async function readBody(init: RequestInit | undefined): Promise<ChatBody> {
  const body = init?.body;
  if (body instanceof FormData) {
    return { chatInput: String(body.get('chatInput') ?? ''), sessionId: String(body.get('sessionId') ?? '') };
  }
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
    return { chatInput: String(parsed.chatInput ?? ''), sessionId: String(parsed.sessionId ?? '') };
  } catch {
    return { chatInput: '', sessionId: '' };
  }
}

/** what the scripted bot says: each Respond to Chat node's message in canvas order, else an echo */
function replyParts(
  workflow: StoredWorkflow,
  asked: string,
): Array<{ nodeId: string; nodeName: string; text: string }> {
  const parts = workflow.nodes
    .filter((node) => node.type === 'ai.chat' && !node.disabled)
    .sort((a, b) => a.position[0] - b.position[0])
    .map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      text: typeof node.parameters.message === 'string' ? node.parameters.message : '',
    }))
    .filter((part) => part.text.trim() !== '' && !part.text.startsWith('='));
  if (parts.length > 0) return parts;
  return [{ nodeId: 'demo', nodeName: 'Demo reply', text: `You said: ${asked}` }];
}

/** The `fetch` the chat panel uses in the demo (and in the editor tests that set it). */
export function demoChatFetch(backend: MockBackend): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const url = new URL(raw, base);
    if (!url.pathname.startsWith('/webhook-test/') || (init?.method ?? 'GET').toUpperCase() !== 'POST') {
      return json(404, { message: 'Not found' });
    }
    const found = backend.testListenByChatToken(headerOf(init, CHAT_TEST_HEADER));
    if (!found) {
      return json(404, {
        code: 404,
        message: 'The requested webhook is not registered.',
        hint: 'Click the chat button in the editor again, then send the message.',
      });
    }
    const { chatInput, sessionId } = await readBody(init);
    const item: Item = { json: { sessionId, action: 'sendMessage', chatInput } };
    const executionId = backend.receiveTestWebhook(found.workflowId, [item]);
    if (!executionId) return json(404, { message: 'The requested webhook is not registered.' });

    const workflow = backend.workflow(found.workflowId);
    const trigger = workflow.nodes.find((node) => node.name === found.listen.nodeName);
    const options = (trigger?.parameters.options ?? {}) as Record<string, unknown>;
    const parts = replyParts(workflow, chatInput);

    if (options.responseMode === 'streaming') {
      const frames: ChatFrame[] = [];
      parts.forEach((part, index) => {
        const metadata: ChatFrameMetadata = {
          nodeId: part.nodeId,
          nodeName: part.nodeName,
          runIndex: 0,
          itemIndex: index,
          timestamp: Date.now(),
        };
        frames.push({ type: 'begin', metadata });
        for (const word of part.text.split(/(?<=\s)/)) frames.push({ type: 'item', content: word, metadata });
        frames.push({ type: 'end', metadata });
      });
      return new Response(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`, {
        status: 200,
        headers: { 'content-type': NDJSON },
      });
    }
    return json(200, { output: parts.map((part) => part.text).join('\n\n') });
  };
}
