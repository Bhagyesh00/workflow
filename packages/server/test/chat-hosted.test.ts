/**
 * P5-56 hosted chat page against the real app on an ephemeral port: the page reply (sandbox CSP, nosniff,
 * no-store, no cookie), the page loaded into jsdom with its own bootstrap mounting the widget, which talks to
 * an Agent on a scripted model with `Origin: null` (the sandbox) and the page token; the `Origin: null` rule,
 * test registrations kept by the page and by a refused POST, and the stale test token refused before any run.
 *
 * The server's program has no DOM lib, so the widget and jsdom are imported by computed names (tsc does not
 * follow them) and the DOM is read through a small typed view of `globalThis`. jsdom is set up by hand for
 * the one widget case, not as the file's environment: with a jsdom file environment the server's own
 * modules are transformed for the browser and nodes-base's `new URL(..., import.meta.url)` fails to load.
 */
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { AiChatResponse, DataObject, NodePackage, WorkflowNode } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { createWorkflow, node, resetDatabase, signup, testConfig, testPackage } from './helpers';

const WIDGET = '@workflow/chat-widget';
const JSDOM_MODULE = 'jsdom';
type CreateChat = (options: Record<string, unknown>) => { unmount(): void };

/** the part of jsdom this file uses */
interface JsdomWindow {
  eval(code: string): unknown;
  close(): void;
  location: { href: string; hash: string };
  WorkflowChat?: { createChat: CreateChat };
}
type Jsdom = new (
  html: string,
  options: { url: string; runScripts: 'outside-only'; pretendToBeVisual: boolean },
) => { window: JsdomWindow };

/** the part of the jsdom DOM this file reads */
interface DomNode {
  textContent: string | null;
  innerHTML: string;
  value: string;
  disabled: boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  click(): void;
}
interface DomView {
  document: { body: DomNode; getElementById(id: string): DomNode | null };
}
const dom = globalThis as unknown as DomView;

/**
 * Gives this process the page's window as its DOM (what a jsdom environment does): every window property
 * that Node lacks becomes a global, so the widget module finds `document`, `window`, `HTMLElement`...
 * Node's own globals (fetch, URL, Event...) stay. Returns the undo.
 */
function installDom(window: JsdomWindow): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const source = window as unknown as Record<string, unknown>;
  const added: string[] = [];
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key in target) continue;
    Object.defineProperty(target, key, { configurable: true, get: () => source[key] });
    added.push(key);
  }
  for (const key of ['window', 'document']) {
    if (added.includes(key)) continue;
    Object.defineProperty(target, key, { configurable: true, value: source[key] });
    added.push(key);
  }
  return () => {
    for (const key of added) delete target[key];
  };
}

/** a chat model that answers with its `text` parameter, word by word when `streaming` is on */
const modelPackage: NodePackage = {
  name: 'chat-hosted-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.hostedChatModel',
        displayName: 'Scripted Chat Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Model' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [
          { displayName: 'Text', name: 'text', type: 'string', default: 'Hello' },
          { displayName: 'Streaming', name: 'streaming', type: 'boolean', default: false },
        ],
      },
      async supplyData(ctx, itemIndex) {
        const text = String(ctx.getNodeParameter('text', itemIndex, 'Hello'));
        const chat = async (): Promise<AiChatResponse> => ({
          message: { role: 'assistant', content: text },
          stopReason: 'end',
        });
        return {
          response: {
            kind: 'chatModel',
            provider: 'test',
            model: 'scripted',
            chat,
            ...(ctx.getNodeParameter('streaming', itemIndex, false)
              ? {
                  async stream(_request: unknown, onDelta: (delta: string) => void) {
                    for (const word of text.split(/(?<= )/)) onDelta(word);
                    return chat();
                  },
                }
              : {}),
          },
        };
      },
    },
  ],
};

let ctx: ServerContext;
let app: FastifyInstance;
let dir: string;
let baseUrl: string;

beforeAll(async () => {
  const config = testConfig();
  dir = config.binaryData.dir;
  ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, nodesAiPackage, modelPackage],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  app = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await ctx.startMain();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase(ctx);
});

const SHOP = 'https://shop.example.com';

function link(from: string, to: string, type = 'main') {
  return { [from]: { [type]: [[{ node: to, type, index: 0 }]] } };
}

const chatTrigger = (options: DataObject, extra: DataObject = {}) =>
  node('Chat', 'ai.chatTrigger', { public: true, options, ...extra }, [0, 0], { webhookId: 'chat-id' });

/** Chat Trigger -> Agent <- scripted model; activated unless `active` is false */
async function agentChat(options: DataObject, text: string, active = true) {
  const { client, tenant } = await signup(app);
  const nodes: WorkflowNode[] = [
    chatTrigger(options),
    node('Agent', 'ai.agent', {}, [200, 0]),
    node('Model', 'test.hostedChatModel', { text, streaming: options.responseMode === 'streaming' }),
  ];
  const wf = await createWorkflow(client, {
    nodes,
    connections: { ...link('Chat', 'Agent'), ...link('Model', 'Agent', 'ai_languageModel') },
  } as never);
  if (active) {
    const activated = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(activated.statusCode, activated.body).toBe(200);
  }
  return { client, tenant, workflowId: wf.id as string, path: `/webhook/${tenant.slug}/chat-id/chat` };
}

const BLOB = /<script type="application\/json" id="chat-config">([^<]*)<\/script>/;
const pageConfigOf = (html: string) => JSON.parse(BLOB.exec(html)?.[1] ?? 'null') as DataObject;

const postChat = (
  url: string,
  headers: Record<string, string>,
  payload: DataObject = { sessionId: 's1', chatInput: 'Hi' },
) => app.inject({ method: 'POST', url, headers, payload });

async function executionCount(client: Awaited<ReturnType<typeof signup>>['client'], workflowId: string) {
  const list = (await client.data(client.get(`/rest/executions?workflowId=${workflowId}`))) as unknown[];
  return list.length;
}

async function waitFor<T>(read: () => T | undefined, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('hosted chat page', () => {
  it('imports the widget by a computed name under vitest', async () => {
    const { createChat } = (await import(/* @vite-ignore */ WIDGET)) as { createChat: CreateChat };
    expect(typeof createChat).toBe('function');
  });

  it('answers the page under the sandbox CSP, nosniff and no-store, with no cookie', async () => {
    const { path } = await agentChat({ title: 'Support' }, 'ok');
    const res = await app.inject({ method: 'GET', url: path, headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.headers['content-security-policy'])).toMatch(/^sandbox /);
    expect(String(res.headers['content-security-policy'])).not.toContain('allow-same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('<script src="/chat-widget/chat.js"></script>');
    expect(pageConfigOf(res.body)).toMatchObject({ webhookUrl: path, title: 'Support' });
  });

  it('runs the page bootstrap in jsdom: the widget gets the agent reply through the sandbox origin', async () => {
    const { path } = await agentChat(
      { responseMode: 'streaming', allowedOrigins: SHOP },
      'Hosted chat works',
    );
    const page = await fetch(`${baseUrl}${path}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MODULE)) as { JSDOM: Jsdom };
    const { window } = new JSDOM(html, {
      url: `${baseUrl}${path}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const uninstall = installDom(window);
    const realFetch = globalThis.fetch;
    // the sandboxed page's requests carry Origin: null; record what the server granted
    const granted: Array<string | null> = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', 'null');
      const response = await realFetch(input, { ...init, headers });
      granted.push(response.headers.get('access-control-allow-origin'));
      return response;
    };
    let mounted: { unmount(): void } | undefined;
    const options: Array<Record<string, unknown>> = [];
    try {
      const { createChat } = (await import(/* @vite-ignore */ WIDGET)) as { createChat: CreateChat };
      window.WorkflowChat = {
        createChat: (o) => {
          options.push(o);
          mounted = createChat(o);
          return mounted;
        },
      };
      const config = JSON.parse(
        dom.document.getElementById('chat-config')?.textContent ?? 'null',
      ) as DataObject;
      // the page's own bootstrap: the last inline script
      const scripts = Array.from(dom.document.body.querySelectorAll('script:not([src]):not([type])'));
      window.eval(scripts[scripts.length - 1]?.textContent ?? '');
      expect(options[0]).toMatchObject({
        webhookUrl: `${baseUrl}${path}`,
        webhookConfig: { method: 'POST', headers: { 'x-chat-page': config.pageToken } },
        mode: 'fullscreen',
        enableStreaming: true,
      });

      const input = await waitFor(() => dom.document.body.querySelector('.chat-input') ?? undefined);
      input.value = 'Hello there';
      dom.document.body.querySelector('.chat-input-send-button')?.click();
      const reply = await waitFor(() => {
        const bots = Array.from(dom.document.body.querySelectorAll('.chat-message-from-bot'));
        return bots.find((m) => m.textContent?.includes('Hosted chat works'));
      });
      expect(reply.textContent).toContain('Hosted chat works');
      expect(granted).toContain('null');
      // the session lives in the fragment, not in storage
      expect(window.location.hash).toMatch(/sessionId=/);
    } finally {
      mounted?.unmount();
      globalThis.fetch = realFetch;
      uninstall();
      window.close();
    }
  });
});

describe('Origin null on a chat', () => {
  it('needs the page token of this chat: none, another node or another tenant gets no grant and 403', async () => {
    const { path, tenant, workflowId } = await agentChat({ allowedOrigins: SHOP }, 'ok');
    const bare = await postChat(path, { origin: 'null' });
    expect(bare.statusCode).toBe(403);
    expect(bare.headers['access-control-allow-origin']).toBeUndefined();

    const { pageToken } = pageConfigOf((await app.inject({ method: 'GET', url: path })).body);
    const ok = await postChat(path, { origin: 'null', 'x-chat-page': String(pageToken) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ output: 'ok' });
    expect(ok.headers['access-control-allow-origin']).toBe('null');
    expect(String(ok.headers.vary)).toContain('Origin');

    const claims = { kind: 'chat-page', tenantId: tenant.id, workflowId, node: 'Chat' };
    for (const other of [
      { ...claims, node: 'Agent' },
      { ...claims, tenantId: 'another-tenant' },
      { ...claims, kind: 'chat-test' },
    ]) {
      const res = await postChat(path, { origin: 'null', 'x-chat-page': ctx.formTokens.sign(other, 60) });
      expect(res.statusCode).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('grants nothing for a bare null entry in the list', async () => {
    const { path } = await agentChat({ allowedOrigins: `${SHOP}, null` }, 'ok');
    const res = await postChat(path, { origin: 'null' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: path,
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('grants the preflight of Origin null on the token header name only', async () => {
    const { path } = await agentChat({ allowedOrigins: SHOP }, 'ok');
    const named = await app.inject({
      method: 'OPTIONS',
      url: path,
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-chat-page',
      },
    });
    expect(named.statusCode).toBe(204);
    expect(named.headers['access-control-allow-origin']).toBe('null');
    expect(String(named.headers['access-control-allow-headers'])).toContain('x-chat-page');
    const unnamed = await app.inject({
      method: 'OPTIONS',
      url: path,
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(unnamed.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps a plain webhook on the list rule and its one-shot test registration', async () => {
    const { client, tenant } = await signup(app);
    const hook = node('Hook', 'core.webhook', {
      path: 'plain',
      httpMethod: 'POST',
      options: { allowedOrigins: 'null' },
    });
    const wf = await createWorkflow(client, { nodes: [hook], connections: {} } as never);
    expect((await client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(200);
    // the list names null, so a plain webhook echoes it as before (the chat-only rule does not apply)
    const res = await postChat(`/webhook/${tenant.slug}/plain`, { origin: 'null' }, {});
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect((await client.post(`/rest/workflows/${wf.id}/deactivate`)).statusCode).toBe(200);

    const listen = (await client.data(
      client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Hook' }),
    )) as DataObject;
    const url = new URL(String(listen.testUrl)).pathname;
    const refused = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-chat-test-token': 'anything' },
      payload: {},
    });
    expect(refused.statusCode).toBe(200);
    // the first call used the registration up
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
  });
});

describe('chat test registrations', () => {
  async function listenChat() {
    const chat = await agentChat({ allowedOrigins: SHOP }, 'test answer', false);
    const listen = async () =>
      (await chat.client.data(
        chat.client.post(`/rest/workflows/${chat.workflowId}/listen-test-webhook`, { nodeName: 'Chat' }),
      )) as DataObject;
    return { ...chat, listen };
  }

  it('keeps the registration through the page GET and a refused POST, and uses it up with an accepted one', async () => {
    const { tenant, workflowId, client, listen } = await listenChat();
    const first = await listen();
    const url = new URL(String(first.testUrl)).pathname;
    const token = String(first.chatTestToken);
    const registrations = async () =>
      (await ctx.testWebhooks.list(tenant.id)).filter((r) => r.workflowId === workflowId);
    expect(await registrations()).toHaveLength(2);

    const page = await app.inject({ method: 'GET', url });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(await registrations()).toHaveLength(2);

    const refused = await postChat(url, { origin: SHOP, 'x-chat-test-token': token }, { sessionId: 's1' });
    expect(refused.statusCode).toBe(400);
    expect(await registrations()).toHaveLength(2);
    expect(await executionCount(client, workflowId)).toBe(0);

    const editor = 'https://editor.example.com';
    const accepted = await postChat(url, { origin: editor, 'x-chat-test-token': token });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ output: 'test answer' });
    // the test token grants the caller's origin, which is not in the list
    expect(accepted.headers['access-control-allow-origin']).toBe(editor);
    expect(await registrations()).toHaveLength(0);
  });

  it('refuses a token of an earlier listen with 403, no run, and the registration kept', async () => {
    const { tenant, workflowId, client, listen } = await listenChat();
    const first = await listen();
    const second = await listen();
    const url = new URL(String(second.testUrl)).pathname;
    const stale = await postChat(url, { origin: SHOP, 'x-chat-test-token': String(first.chatTestToken) });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('forbidden');
    expect(await executionCount(client, workflowId)).toBe(0);
    const kept = (await ctx.testWebhooks.list(tenant.id)).filter((r) => r.workflowId === workflowId);
    expect(kept).toHaveLength(2);
    const listenId = ctx.formTokens.verify(String(second.chatTestToken))?.listenId;
    expect(kept.every((r) => r.listenId === listenId)).toBe(true);

    const fresh = await postChat(url, { origin: SHOP, 'x-chat-test-token': String(second.chatTestToken) });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(await executionCount(client, workflowId)).toBe(1);
  });
});
