import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseButtonsMessage } from '../src/components/buttons';
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

function ndjson(lines: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

let mounted: ChatInstance[] = [];

function mount(
  buttonsMessage: unknown,
  onGet: (call: Call) => Response | Promise<Response>,
  options: Partial<ChatOptions> = {},
) {
  const calls: Call[] = [];
  const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    if (call.init.method === 'GET') return onGet(call);
    return json({ output: JSON.stringify(buttonsMessage) });
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const chat = createChat({
    webhookUrl: WEBHOOK,
    target,
    mode: 'fullscreen',
    loadPreviousSession: false,
    sessionId: 's',
    webhookConfig: { headers: { 'x-chat-page': 'tok' } },
    fetch: fetchFake as unknown as typeof fetch,
    ...options,
  });
  mounted.push(chat);
  return { chat, target, calls, area: target.querySelector('textarea') as HTMLTextAreaElement };
}

async function ask(area: HTMLTextAreaElement): Promise<void> {
  area.value = 'go';
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  await flush();
  await flush();
}

afterEach(() => {
  for (const chat of mounted) chat.unmount();
  mounted = [];
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

const APPROVE = 'http://localhost:3000/webhook-waiting/exec-9?approved=true';
const DENY = 'http://localhost:3000/webhook-waiting/exec-9?approved=false';

describe('with-buttons messages', () => {
  it('parses the JSON shape and nothing else', () => {
    expect(
      parseButtonsMessage(
        JSON.stringify({
          type: 'with-buttons',
          text: 'Approve?',
          buttons: [{ text: 'Yes', link: APPROVE, type: 'primary' }],
          blockUserInput: true,
        }),
      ),
    ).toEqual({
      text: 'Approve?',
      buttons: [{ text: 'Yes', link: APPROVE, type: 'primary' }],
      blockUserInput: true,
    });
    expect(parseButtonsMessage('{"type":"other"}')).toBeNull();
    expect(parseButtonsMessage('plain text')).toBeNull();
    expect(parseButtonsMessage('{bad json')).toBeNull();
    expect(parseButtonsMessage('{"type":"with-buttons","buttons":"no"}')).toBeNull();
  });

  it('shows the text and a button per link with the webhook origin', async () => {
    const { target, area } = mount(
      {
        type: 'with-buttons',
        text: 'Approve **this**?',
        buttons: [
          { text: 'Approve', link: APPROVE, type: 'primary' },
          { text: 'Decline', link: DENY, type: 'secondary' },
        ],
        blockUserInput: false,
      },
      () => json({}),
    );
    await ask(area);
    const buttons = Array.from(target.querySelectorAll('.chat-buttons .chat-button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Approve', 'Decline']);
    expect(buttons[0]?.classList.contains('chat-button-primary')).toBe(true);
    expect(buttons[1]?.classList.contains('chat-button-secondary')).toBe(true);
    expect(target.querySelector('.chat-message-from-bot strong')?.textContent).toBe('this');
  });

  it('shows no button for another origin, another port, another scheme or a script link', async () => {
    const { target, area } = mount(
      {
        type: 'with-buttons',
        text: 'Pick',
        buttons: [
          { text: 'Other host', link: 'http://evil.test/webhook-waiting/1' },
          { text: 'Other port', link: 'http://localhost:3999/webhook-waiting/1' },
          { text: 'Other scheme', link: 'https://localhost:3000/webhook-waiting/1' },
          { text: 'Script', link: 'javascript:alert(1)' },
          { text: 'Lookalike', link: 'http://localhost:3000.evil.test/x' },
          { text: 'Own', link: APPROVE },
        ],
      },
      () => json({}),
    );
    await ask(area);
    expect(Array.from(target.querySelectorAll('.chat-button')).map((b) => b.textContent)).toEqual(['Own']);
  });

  it('shows only the text when no link has the webhook origin, and does not block the input', async () => {
    const { target, area } = mount(
      {
        type: 'with-buttons',
        text: 'Nothing to click',
        buttons: [{ text: 'X', link: 'http://evil.test/a' }],
        blockUserInput: true,
      },
      () => json({}),
    );
    await ask(area);
    expect(target.querySelectorAll('.chat-button')).toHaveLength(0);
    expect(area.disabled).toBe(false);
  });

  it('a click does a GET of the link with Accept: application/x-ndjson and the page headers, and reads the stream', async () => {
    const meta = { nodeId: 'n', nodeName: 'n', runIndex: 0, itemIndex: 0, timestamp: 1 };
    const { target, calls, area } = mount(
      {
        type: 'with-buttons',
        text: 'Approve?',
        buttons: [{ text: 'Approve', link: APPROVE, type: 'primary' }],
      },
      () =>
        ndjson([
          { type: 'begin', metadata: meta },
          { type: 'item', content: 'Approved, continuing', metadata: meta },
          { type: 'end', metadata: meta },
        ]),
    );
    await ask(area);
    (target.querySelector('.chat-button') as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    const get = calls.find((c) => c.init.method === 'GET');
    expect(get?.url).toBe(APPROVE);
    const headers = get?.init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/x-ndjson');
    expect(headers['x-chat-page']).toBe('tok');
    expect(get?.init.credentials).toBe('omit');
    const bots = Array.from(target.querySelectorAll('.chat-message-from-bot:not(.chat-message-typing)')).map(
      (m) => m.textContent,
    );
    expect(bots.at(-1)).toBe('Approved, continuing');
  });

  it('shows a plain reply of the GET as a message', async () => {
    const { target, area } = mount(
      { type: 'with-buttons', text: 'Approve?', buttons: [{ text: 'Approve', link: APPROVE }] },
      () => json({ output: 'Recorded' }),
    );
    await ask(area);
    (target.querySelector('.chat-button') as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    expect(target.textContent).toContain('Recorded');
  });

  it('blockUserInput keeps the input off until a button was used', async () => {
    const { target, area } = mount(
      {
        type: 'with-buttons',
        text: 'Decide',
        buttons: [
          { text: 'Approve', link: APPROVE },
          { text: 'Decline', link: DENY },
        ],
        blockUserInput: true,
      },
      () => json({ output: 'ok' }),
    );
    await ask(area);
    expect(area.disabled).toBe(true);
    (target.querySelector('.chat-button') as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    expect(area.disabled).toBe(false);
    // a used message cannot be answered twice
    expect(
      Array.from(target.querySelectorAll('.chat-button')).every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it('a failed click shows one error and lets the person click again', async () => {
    let n = 0;
    const { target, area } = mount(
      {
        type: 'with-buttons',
        text: 'Approve?',
        buttons: [{ text: 'Approve', link: APPROVE }],
        blockUserInput: true,
      },
      () => (++n === 1 ? json({ message: 'Link expired' }, 410) : json({ output: 'ok' })),
    );
    await ask(area);
    (target.querySelector('.chat-button') as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    expect(target.querySelector('.chat-message-error')?.textContent).toBe('Link expired');
    expect((target.querySelector('.chat-button') as HTMLButtonElement).disabled).toBe(false);
    expect(area.disabled).toBe(true);
  });

  it('a click answers the wait: the next typed message goes to the webhook, not to the stored resume URL', async () => {
    const RESUME = 'http://localhost:3000/webhook-waiting/exec-9?signature=s';
    const meta = { nodeId: 'n', nodeName: 'n', runIndex: 0, itemIndex: 0, timestamp: 1 };
    const approval = {
      type: 'with-buttons',
      text: 'Approve?',
      buttons: [{ text: 'Approve', link: APPROVE }],
    };
    const posts: string[] = [];
    const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'GET') return json({ output: 'Done' });
      posts.push(String(url));
      if (posts.length === 1) {
        return ndjson([
          { type: 'item', content: JSON.stringify(approval), metadata: meta },
          { type: 'wait', resumeUrl: RESUME },
        ]);
      }
      // what the server answers when the run is over
      return String(url) === RESUME
        ? json({ message: 'The execution is not waiting' }, 409)
        : json({ output: 'new run' });
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      createChat({
        webhookUrl: WEBHOOK,
        target,
        mode: 'fullscreen',
        loadPreviousSession: false,
        sessionId: 's',
        fetch: fetchFake as unknown as typeof fetch,
      }),
    );
    const area = target.querySelector('textarea') as HTMLTextAreaElement;
    await ask(area);
    (target.querySelector('.chat-button') as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    await ask(area);
    expect(posts).toEqual([WEBHOOK, WEBHOOK]);
    expect(target.querySelector('.chat-message-error')).toBeNull();
  });

  it('writes button text as text', async () => {
    const { target, area } = mount(
      { type: 'with-buttons', text: 't', buttons: [{ text: '<img src=x onerror=alert(1)>', link: APPROVE }] },
      () => json({}),
    );
    await ask(area);
    expect(target.querySelectorAll('img')).toHaveLength(0);
    expect(target.querySelector('.chat-button')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
