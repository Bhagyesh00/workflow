/**
 * Demo Assistant confirmations (P5-68, lane L3): POST `/assistant/confirm/:requestId` (`assistantApi.confirm`,
 * the body is the `AssistantConfirmAnswer`) on the in-memory MockBackend, resolving a pending card of a demo
 * thread and playing the `confirmation-resolved` event and the rest of the turn.
 *
 * As the server: only the signed-in user's own card in this workspace is found (else 404, also for a second
 * answer); the answer's kind must match the card; the body carries no args (anything but the answer is
 * ignored). An approved call gets a demo result, a denied one reads `The person refused this`; once the turn
 * has no card left, a short resumed turn answers. `addDemoConfirmation` puts a card on a demo thread (the
 * `confirmation-request` event and the waiting call), for demo scripts and tests.
 */
import type { AssistantConfirmation } from '@workflow/workflow';
import { assistantDemoState, type DemoAssistantThread, publishAssistantDemoEvent } from './mock-assistant';
import type { MockBackend } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

/** what the call reads after a denial, and while it waits (the server's texts) */
const REFUSED = 'The person refused this';
const WAITING = "Waiting for the person's approval";

let counter = 0;
const nextId = (prefix: string) => {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
};

function ownCard(
  backend: MockBackend,
  requestId: string,
): { thread: DemoAssistantThread; card: AssistantConfirmation } {
  const { user, tenant } = backend.auth();
  for (const thread of assistantDemoState(backend).threads.values()) {
    if (thread.userId !== user.id || thread.tenantId !== tenant.id) continue;
    const card = thread.pending.find((entry) => entry.requestId === requestId);
    if (card) return { thread, card };
  }
  throw new HttpError(404, 'not_found', 'Approval request not found');
}

/** sets the content of the call's tool message (the placeholder), or adds one */
function setToolResult(thread: DemoAssistantThread, card: AssistantConfirmation, content: string): void {
  const message = thread.messages.find((m) => m.role === 'tool' && m.toolCallId === card.toolCallId);
  if (message) {
    message.content = content;
    return;
  }
  thread.messages.push({
    id: nextId('msg'),
    runId: null,
    role: 'tool',
    content,
    toolCallId: card.toolCallId,
    name: card.toolName,
    summarized: false,
    createdAt: now(),
  });
}

/**
 * Puts a waiting card on a demo thread: the call's placeholder result, the card in the thread's pending list and
 * the `confirmation-request` event. Returns the card as stored.
 */
export function addDemoConfirmation(
  backend: MockBackend,
  threadId: string,
  confirmation: AssistantConfirmation,
): AssistantConfirmation {
  const thread = assistantDemoState(backend).threads.get(threadId);
  if (!thread) throw new HttpError(404, 'not_found', 'Thread not found');
  const card = copy(confirmation);
  setToolResult(thread, card, WAITING);
  thread.pending = [...thread.pending.filter((entry) => entry.requestId !== card.requestId), card];
  publishAssistantDemoEvent(backend, thread.id, 'confirmation-request', { confirmation: copy(card) });
  return card;
}

/** the answer's outcome, as the server decides it */
function outcomeOf(card: AssistantConfirmation, body: Record<string, unknown>): 'approved' | 'denied' {
  if (body.kind !== card.inputType) {
    throw new HttpError(400, 'bad_request', `This request takes an answer of kind "${card.inputType}"`);
  }
  switch (card.inputType) {
    case 'approval':
      if (typeof body.approved !== 'boolean') throw new HttpError(400, 'bad_request', 'approved: Required');
      return body.approved ? 'approved' : 'denied';
    case 'domain':
      return body.action === 'deny' ? 'denied' : 'approved';
    default:
      return 'approved';
  }
}

/** the rest of the turn once no card is left: a short resumed answer */
function resume(backend: MockBackend, thread: DemoAssistantThread, outcome: 'approved' | 'denied'): void {
  const state = assistantDemoState(backend);
  const runId = nextId('run');
  const run = {
    id: runId,
    timer: null as ReturnType<typeof setTimeout> | null,
    openCalls: new Map<string, string>(),
  };
  thread.run = run;
  run.timer = setTimeout(() => {
    run.timer = null;
    if (thread.run !== run) return;
    publishAssistantDemoEvent(backend, thread.id, 'run-start', { resumed: true }, runId);
    const text =
      outcome === 'approved' ? 'Done. It ran with the values you approved.' : 'Ok, I left it as it was.';
    const messageId = nextId('msg');
    thread.messages.push({
      id: messageId,
      runId,
      role: 'assistant',
      content: text,
      summarized: false,
      createdAt: now(),
    });
    thread.updatedAt = now();
    publishAssistantDemoEvent(backend, thread.id, 'text-block', { messageId, text }, runId);
    thread.run = null;
    publishAssistantDemoEvent(backend, thread.id, 'run-finish', { status: 'completed' }, runId);
  }, state.stepMs);
}

/** P5-68: registers the demo confirm route. */
export function registerAssistantConfirmRoutes(backend: MockBackend): void {
  backend.on('POST', '/assistant/confirm/:requestId', ({ params, body }) => {
    if (backend.options.assistant && !backend.options.assistant.enabled) {
      throw new HttpError(403, 'forbidden', 'The Assistant is off for this workspace');
    }
    const { thread, card } = ownCard(backend, params[0]);
    const outcome = outcomeOf(card, body);
    thread.pending = thread.pending.filter((entry) => entry.requestId !== card.requestId);
    if (outcome === 'denied') {
      setToolResult(thread, card, REFUSED);
    } else {
      const result = JSON.stringify({ ok: true });
      setToolResult(thread, card, result);
      publishAssistantDemoEvent(
        backend,
        thread.id,
        'tool-result',
        { toolCallId: card.toolCallId, toolName: card.toolName, result },
        null,
      );
    }
    publishAssistantDemoEvent(backend, thread.id, 'confirmation-resolved', {
      requestId: card.requestId,
      toolCallId: card.toolCallId,
      outcome,
    });
    if (!thread.pending.length && !thread.run) resume(backend, thread, outcome);
    return { ok: true };
  });
}
