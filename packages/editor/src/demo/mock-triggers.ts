/**
 * Demo routes for test-listening on a trigger without a URL. State lives in `backend.ext.triggerListening`;
 * the first event starts a manual run, which the editor adopts like the run of a test webhook call.
 */
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

const LISTEN_MS = 120_000;

type Listening = Map<string, { nodeName: string; expiresAt: number }>;

function listeningOf(backend: MockBackend): Listening {
  backend.ext.triggerListening ??= new Map();
  return backend.ext.triggerListening as Listening;
}

export function registerTriggerListenRoutes(backend: MockBackend): void {
  // the demo has no running triggers, so none of them is down
  backend.on('GET', '/active-workflows/error/:id', ({ params }) => {
    backend.auth();
    backend.workflow(params[0]);
    return null;
  });
  backend.on('POST', '/workflows/:id/listen-test-trigger', ({ params, body }) => {
    backend.requireRole('editor');
    const wf = backend.workflow(params[0]);
    const nodeName = String(body.nodeName ?? '');
    if (!wf.nodes.some((n) => n.name === nodeName))
      throw new HttpError(400, 'bad_request', `Node "${nodeName}" does not exist`);
    const expiresAt = Date.now() + LISTEN_MS;
    listeningOf(backend).set(wf.id, { nodeName, expiresAt });
    if (backend.options.autoWebhookMs)
      setTimeout(() => void receiveTestTrigger(backend, wf.id), backend.options.autoWebhookMs);
    return { expiresAt: new Date(expiresAt).toISOString() };
  });
  backend.on('DELETE', '/workflows/:id/listen-test-trigger', ({ params }) => {
    backend.requireRole('editor');
    listeningOf(backend).delete(backend.workflow(params[0]).id);
    return { ok: true };
  });
}

/** Simulate the first event of a listening trigger; null when nothing listens. */
export async function receiveTestTrigger(backend: MockBackend, workflowId: string): Promise<string | null> {
  const listening = listeningOf(backend);
  const listen = listening.get(workflowId);
  if (!listen || listen.expiresAt < Date.now()) return null;
  listening.delete(workflowId);
  const { body } = await backend.handle({
    method: 'POST',
    path: `/workflows/${workflowId}/run`,
    body: { startNode: listen.nodeName },
  });
  const executionId = (body as { data?: { executionId?: string } }).data?.executionId;
  if (!executionId) return null;
  backend.emit({ type: 'testWebhookReceived', data: { workflowId, executionId } });
  return executionId;
}
