import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, errorTextOf, hasWebhookOrigin, parseReply } from '../src/api';
import { type ChatInstance, type ChatOptions, createChat } from '../src/index';

const WEBHOOK = 'http://localhost:3000/webhook/abc/chat';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ndjson(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

let mounted: ChatInstance[] = [];

function mount(options: Partial<ChatOptions>, responder: Responder) {
  const calls: Call[] = [];
  const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const chat = createChat({
    webhookUrl: WEBHOOK,
    target,
    mode: 'fullscreen',
    loadPreviousSession: false,
    sessionId: 'sess-1',
    fetch: fetchFake as unknown as typeof fetch,
    ...options,
  });
  mounted.push(chat);
  return { chat, target, calls };
}

async function send(target: HTMLElement, text: string): Promise<void> {
  const area = target.querySelector('textarea') as HTMLTextAreaElement;
  area.value = text;
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  await flush();
  await flush();
}

const botTexts = (target: HTMLElement) =>
  Array.from(
    target.querySelectorAll('.chat-message-from-bot:not(.chat-message-typing):not(.chat-message-error)'),
  ).map((m) => m.textContent);

afterEach(() => {
  for (const chat of mounted) chat.unmount();
  mounted = [];
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

describe('request bodies', () => {
  it('posts JSON with action, session id, chat input and metadata', async () => {
    const { target, calls } = mount({ metadata: { source: 'test' } }, () => json({ output: 'ok' }));
    await send(target, 'hello');
    const call = calls[0];
    expect(call?.url).toBe(WEBHOOK);
    expect(call?.init.method).toBe('POST');
    expect(((call?.init.headers ?? {}) as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      action: 'sendMessage',
      sessionId: 'sess-1',
      chatInput: 'hello',
      metadata: { source: 'test' },
    });
  });

  it('sends multipart with files when files are attached', async () => {
    const { target, calls } = mount({ allowFileUploads: true }, () => json({ output: 'got it' }));
    const input = target.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['abc'], 'note.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await send(target, 'see file');
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('action')).toBe('sendMessage');
    expect(form.get('sessionId')).toBe('sess-1');
    expect(form.get('chatInput')).toBe('see file');
    expect(form.getAll('files')).toHaveLength(1);
    expect((form.getAll('files')[0] as File).name).toBe('note.txt');
    // the browser must set the multipart boundary itself
    expect(Object.keys(calls[0]?.init.headers as Record<string, string>)).not.toContain('Content-Type');
    // the chips clear after a successful send
    expect(target.querySelectorAll('.chat-files .chat-file')).toHaveLength(0);
  });

  it('sends a GET with query parameters when webhookConfig.method is GET', async () => {
    const { target, calls } = mount({ webhookConfig: { method: 'GET' } }, () => json({ output: 'ok' }));
    await send(target, 'hi there');
    expect(calls[0]?.init.method).toBe('GET');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('chatInput')).toBe('hi there');
    expect(url.searchParams.get('action')).toBe('sendMessage');
    expect(calls[0]?.init.body).toBeUndefined();
  });
});

describe('credentials and headers', () => {
  it("sets credentials: 'omit' on every request, whatever fetch is used", async () => {
    const { target, calls } = mount(
      {
        loadPreviousSession: true,
        webhookConfig: { headers: { 'x-chat-page': 'tok' } },
        enableMessageActions: true,
      },
      (call) => {
        const body = typeof call.init.body === 'string' ? JSON.parse(call.init.body) : {};
        if (body.action === 'loadPreviousSession') return json({ data: [] });
        return json({ output: 'ok' });
      },
    );
    await flush();
    await send(target, 'one');
    await send(target, 'two');
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call.init.credentials).toBe('omit');
  });

  it('takes headers from webhookConfig, then from beforeMessageSent', async () => {
    const { target, calls } = mount(
      {
        webhookConfig: { headers: { 'x-chat-page': 'page-token', 'x-auth-token': 'a1', 'x-keep': 'k' } },
        beforeMessageSent: () => ({ headers: { 'x-auth-token': 'a2', 'x-extra': 'e' } }),
      },
      () => json({ output: 'ok' }),
    );
    await send(target, 'hi');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-chat-page']).toBe('page-token');
    expect(headers['x-auth-token']).toBe('a2');
    expect(headers['x-keep']).toBe('k');
    expect(headers['x-extra']).toBe('e');
  });

  it('lets beforeMessageSent change the URL only to the webhook origin', async () => {
    const { target, calls } = mount(
      {
        beforeMessageSent: (message) => ({
          url: message === 'same' ? 'http://localhost:3000/webhook/other' : 'http://evil.test/steal',
        }),
      },
      () => json({ output: 'ok' }),
    );
    await send(target, 'same');
    await send(target, 'other');
    expect(calls[0]?.url).toBe('http://localhost:3000/webhook/other');
    expect(calls[1]?.url).toBe(WEBHOOK);
  });

  it('calls afterMessageSent with the message and the reply', async () => {
    const after = vi.fn();
    const { target } = mount({ afterMessageSent: after }, () => json({ output: 'answer' }));
    await send(target, 'q');
    expect(after).toHaveBeenCalledWith('q', { output: 'answer' });
  });
});

describe('reply parsing', () => {
  it('reads output, then text, then message', () => {
    expect(parseReply('{"output":"a","text":"b"}', 'application/json')).toEqual({ kind: 'text', text: 'a' });
    expect(parseReply('{"text":"b","message":"c"}', 'application/json')).toEqual({ kind: 'text', text: 'b' });
    expect(parseReply('{"message":"c"}', 'application/json')).toEqual({ kind: 'text', text: 'c' });
  });

  it('falls back to the JSON text, then to the raw body', () => {
    expect(parseReply('{"n":1}', 'application/json')).toEqual({ kind: 'text', text: '{"n":1}' });
    expect(parseReply('[1,2]', 'application/json')).toEqual({ kind: 'text', text: '[1,2]' });
    expect(parseReply('plain words', 'text/plain')).toEqual({ kind: 'text', text: 'plain words' });
    expect(parseReply('', 'text/plain')).toEqual({ kind: 'text', text: '' });
  });

  it('detects a web page', () => {
    expect(parseReply('<!DOCTYPE html><html></html>', 'text/html')).toEqual({ kind: 'html' });
    expect(parseReply('<html><body>502</body></html>', 'text/plain')).toEqual({ kind: 'html' });
  });

  it('shows each reply shape in the page', async () => {
    const replies = [
      json({ output: 'from output' }),
      json({ text: 'from text' }),
      json({ message: 'from message' }),
      json({ n: 1 }),
    ];
    const { target } = mount({}, (_call, index) => replies[index] as Response);
    for (const text of ['1', '2', '3', '4']) await send(target, text);
    expect(botTexts(target)).toEqual(['from output', 'from text', 'from message', '{"n":1}']);
  });

  it('answers a web page with one error and keeps the text', async () => {
    const { target } = mount(
      {},
      () =>
        new Response('<html><body>Bad gateway</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await send(target, 'keep me');
    expect(target.querySelectorAll('.chat-message-error')).toHaveLength(1);
    expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe('keep me');
  });
});

describe('error replies', () => {
  for (const status of [401, 403]) {
    it(`shows the message of a ${status} JSON reply as one error and keeps the typed text`, async () => {
      const { target } = mount({}, () => json({ message: `Denied with ${status}` }, status));
      await send(target, 'my question');
      const errors = target.querySelectorAll('.chat-message-error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.textContent).toBe(`Denied with ${status}`);
      expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe('my question');
      // the failed message is not left as a sent bubble
      expect(target.querySelectorAll('.chat-message-from-user')).toHaveLength(0);
      expect((target.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    });
  }

  it('uses a generic line with the status when the body has no message', () => {
    expect(errorTextOf(500, '{}', 'application/json')).toContain('500');
    expect(errorTextOf(502, '<html>x</html>', 'text/html')).toMatch(/web page/);
  });

  it('shows one error when the network fails', async () => {
    const { target } = mount({}, () => {
      throw new TypeError('Failed to fetch');
    });
    await send(target, 'x');
    expect(target.querySelectorAll('.chat-message-error')).toHaveLength(1);
    expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe('x');
  });
});

describe('wait frame', () => {
  const RESUME = 'http://localhost:3000/webhook-waiting/exec-1?signature=s';

  it('sends the next message to resumeUrl, reads its stream, then goes back to the webhook', async () => {
    const wait = JSON.stringify({ type: 'wait', resumeUrl: RESUME });
    const begin = (id: string) =>
      JSON.stringify({
        type: 'begin',
        metadata: { nodeId: id, nodeName: id, runIndex: 0, itemIndex: 0, timestamp: 1 },
      });
    const item = (id: string, content: string) =>
      JSON.stringify({
        type: 'item',
        content,
        metadata: { nodeId: id, nodeName: id, runIndex: 0, itemIndex: 0, timestamp: 2 },
      });
    const end = (id: string) =>
      JSON.stringify({
        type: 'end',
        metadata: { nodeId: id, nodeName: id, runIndex: 0, itemIndex: 0, timestamp: 3 },
      });
    const { target, calls } = mount(
      { webhookConfig: { headers: { 'x-chat-page': 'tok' } } },
      (_call, index) => {
        if (index === 0) return ndjson([`${begin('a')}\n${item('a', 'Which one?')}\n${end('a')}\n${wait}\n`]);
        if (index === 1) return ndjson([`${begin('b')}\n${item('b', 'Thanks')}\n${end('b')}\n`]);
        return json({ output: 'back on webhook' });
      },
    );
    await send(target, 'start');
    await send(target, 'the answer');
    await send(target, 'later');
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[1]?.url).toBe(RESUME);
    expect(calls[2]?.url).toBe(WEBHOOK);
    expect(botTexts(target)).toEqual(['Which one?', 'Thanks', 'back on webhook']);
  });

  it('ignores a wait with another origin: the next message goes to the webhook and nothing reaches that origin', async () => {
    const evil = 'http://evil.test/webhook-waiting/1';
    const { target, calls } = mount(
      { webhookConfig: { headers: { 'x-chat-page': 'tok', 'x-auth-token': 'secret' } } },
      (_c, index) =>
        index === 0
          ? ndjson([`${JSON.stringify({ type: 'wait', resumeUrl: evil })}\n`])
          : json({ output: 'ok' }),
    );
    await send(target, 'one');
    await send(target, 'two');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, WEBHOOK]);
    expect(calls.some((c) => c.url.includes('evil.test'))).toBe(false);
  });

  it('ignores a wait for a scheme that is not http', async () => {
    const { target, calls } = mount({}, (_c, index) =>
      index === 0
        ? ndjson([`${JSON.stringify({ type: 'wait', resumeUrl: 'javascript:alert(1)' })}\n`])
        : json({ output: 'ok' }),
    );
    await send(target, 'one');
    await send(target, 'two');
    expect(calls[1]?.url).toBe(WEBHOOK);
  });

  it('keeps the resume URL when the post to it fails', async () => {
    const { target, calls } = mount({}, (_c, index) => {
      if (index === 0) return ndjson([`${JSON.stringify({ type: 'wait', resumeUrl: RESUME })}\n`]);
      if (index === 1) return json({ message: 'Try again' }, 503);
      return json({ output: 'ok' });
    });
    await send(target, 'one');
    await send(target, 'two');
    await send(target, 'two');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, RESUME, RESUME]);
  });

  it('drops the resume URL when the run no longer waits (409), so the next message starts a new run', async () => {
    const { target, calls } = mount({}, (_c, index) => {
      if (index === 0) return ndjson([`${JSON.stringify({ type: 'wait', resumeUrl: RESUME })}\n`]);
      if (index === 1) return json({ message: 'The execution is not waiting' }, 409);
      return json({ output: 'new run' });
    });
    await send(target, 'one');
    await send(target, 'two');
    expect(target.querySelector('.chat-message-error')?.textContent).toBe('The execution is not waiting');
    // the text stays in the input, the person sends it again
    expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe('two');
    await send(target, 'two');
    await send(target, 'three');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, RESUME, WEBHOOK, WEBHOOK]);
  });

  it('keeps the resume URL after a 429', async () => {
    const { target, calls } = mount({}, (_c, index) => {
      if (index === 0) return ndjson([`${JSON.stringify({ type: 'wait', resumeUrl: RESUME })}\n`]);
      if (index === 1) return json({ message: 'Slow down' }, 429);
      return json({ output: 'ok' });
    });
    await send(target, 'one');
    await send(target, 'two');
    await send(target, 'two');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, RESUME, RESUME]);
  });

  it('newSession during a reply: the old stream writes nothing and its wait frame sets no resume URL', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enc = new TextEncoder();
    const meta = { nodeId: 'a', nodeName: 'a', runIndex: 0, itemIndex: 0, timestamp: 1 };
    const line = (frame: unknown) => enc.encode(`${JSON.stringify(frame)}\n`);
    const slow = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(line({ type: 'item', content: 'first', metadata: meta }));
            await gate;
            controller.enqueue(line({ type: 'item', content: 'late', metadata: meta }));
            controller.enqueue(line({ type: 'wait', resumeUrl: RESUME }));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    const { chat, target, calls } = mount({}, (_c, index) =>
      index === 0 ? slow() : json({ output: 'fresh' }),
    );
    const area = target.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'start';
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    await flush();
    chat.newSession('sess-2');
    release();
    await flush();
    await flush();
    await flush();
    expect(botTexts(target)).toEqual([]);
    await send(target, 'hello');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK, WEBHOOK]);
    expect(botTexts(target)).toEqual(['fresh']);
  });
});

describe('origin helper', () => {
  it('compares the origin of new URL(webhookUrl, location.href)', () => {
    expect(hasWebhookOrigin('http://localhost:3000/x', WEBHOOK)).toBe(true);
    expect(hasWebhookOrigin('/webhook-waiting/1', WEBHOOK)).toBe(true);
    expect(hasWebhookOrigin('http://localhost:3001/x', WEBHOOK)).toBe(false);
    expect(hasWebhookOrigin('https://localhost:3000/x', WEBHOOK)).toBe(false);
    expect(hasWebhookOrigin('javascript:alert(1)', WEBHOOK)).toBe(false);
    expect(hasWebhookOrigin('http://localhost:3000.evil.test/x', WEBHOOK)).toBe(false);
  });

  it('works with a relative webhook URL on the hosted page', () => {
    expect(hasWebhookOrigin('http://localhost:3000/webhook-waiting/1', '/webhook/abc/chat')).toBe(true);
  });
});

describe('createApi', () => {
  it('loadPrevious maps Human and AI messages and ignores the rest', async () => {
    const fetchFake = vi.fn(async () =>
      json({
        data: [
          { id: ['a', 'HumanMessage'], kwargs: { content: 'q' } },
          { id: ['a', 'AIMessage'], kwargs: { content: 'a' } },
          { id: ['a', 'SystemMessage'], kwargs: { content: 's' } },
          { id: ['a', 'AIMessage'], kwargs: { content: 5 } },
        ],
      }),
    );
    const api = createApi({
      webhookUrl: WEBHOOK,
      chatInputKey: 'chatInput',
      chatSessionKey: 'sessionId',
      fetch: fetchFake as unknown as typeof fetch,
    });
    const messages = await api.loadPrevious('s1');
    expect(messages.map((m) => [m.sender, m.text])).toEqual([
      ['user', 'q'],
      ['bot', 'a'],
    ]);
    const init = fetchFake.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].credentials).toBe('omit');
    expect(JSON.parse(String(init[1].body))).toEqual({ action: 'loadPreviousSession', sessionId: 's1' });
  });

  it('loadPrevious returns nothing when the server fails', async () => {
    const api = createApi({
      webhookUrl: WEBHOOK,
      chatInputKey: 'chatInput',
      chatSessionKey: 'sessionId',
      fetch: (async () => json({ message: 'no' }, 500)) as unknown as typeof fetch,
    });
    expect(await api.loadPrevious('s1')).toEqual([]);
  });
});
