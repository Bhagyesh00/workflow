/**
 * Demo routes for test-listening on a trigger without a URL. State lives in `backend.ext.triggerListening`;
 * the first event starts a manual run, which the editor adopts like the run of a test webhook call.
 */
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

const LISTEN_MS = 120_000;

/** P5-03: the MCP Server Trigger's node type */
export const DEMO_MCP_TRIGGER_TYPE = 'ai.mcpTrigger';

/** the URL family of a hook, as the server's `webhookUrlBase` (services/webhook-paths.ts) */
export type DemoHookFamily = 'webhook' | 'form' | 'mcp';

/** The URL family of a trigger's hooks: `/form` for a Form Trigger, `/mcp` for an MCP Server Trigger, else `/webhook`. */
export function demoHookFamily(nodeType: string): DemoHookFamily {
  if (nodeType === 'core.formTrigger') return 'form';
  if (nodeType === DEMO_MCP_TRIGGER_TYPE) return 'mcp';
  return 'webhook';
}

/**
 * A hook's public URL in the demo, as the server's `hookUrl`: `<origin>/<family>[-test]/<slug>/<path>`. MCP hooks
 * use the server's default `ENDPOINT_MCP` (`mcp`) and `ENDPOINT_MCP_TEST` (`mcp-test`) on the same origin
 * (MCP_BASE_URL unset).
 */
export function demoHookUrl(
  origin: string,
  family: DemoHookFamily,
  test: boolean,
  slug: string,
  path: string,
): string {
  return `${origin}/${family}${test ? '-test' : ''}/${slug}/${path}`;
}

/** The HTTP method the demo lists for a trigger's URL: a form's page (GET), MCP's Streamable HTTP POST, else the node's. */
export function demoHookMethod(family: DemoHookFamily, httpMethod: unknown): string {
  if (family === 'form') return 'GET';
  if (family === 'mcp') return 'POST';
  return String(httpMethod ?? 'POST');
}

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
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(wf) });
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
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(wf) });
    listeningOf(backend).delete(wf.id);
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
