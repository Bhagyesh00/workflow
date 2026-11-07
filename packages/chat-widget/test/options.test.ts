import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STRINGS, mergeStrings } from '../src/i18n';
import { type ChatInstance, type ChatOptions, createChat } from '../src/index';

const WEBHOOK = 'http://localhost:3000/webhook/abc/chat';

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(options: Partial<ChatOptions> = {}, reply: () => Response = () => json({ data: [] })) {
  const calls: Call[] = [];
  const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const chat = createChat({
    webhookUrl: WEBHOOK,
    target,
    fetch: fetchFake as unknown as typeof fetch,
    ...options,
  });
  return { chat, target, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function textarea(target: HTMLElement): HTMLTextAreaElement {
  const node = target.querySelector('textarea');
  if (!node) throw new Error('no textarea');
  return node;
}

async function sendText(target: HTMLElement, text: string): Promise<void> {
  const area = textarea(target);
  area.value = text;
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  await flush();
}

let mounted: ChatInstance[] = [];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  for (const chat of mounted) chat.unmount();
  mounted = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(options: Partial<ChatOptions> = {}, reply?: () => Response) {
  const result = setup(options, reply);
  mounted.push(result.chat);
  return result;
}

describe('option defaults', () => {
  it('uses window mode, no welcome screen and loads the previous session', async () => {
    const { target, calls } = mount();
    await flush();
    const layout = target.querySelector('.chat-layout');
    expect(layout?.classList.contains('chat-layout-window')).toBe(true);
    // the window starts closed, the toggle is there
    expect((target.querySelector('.chat-window') as HTMLElement).hidden).toBe(true);
    expect(target.querySelector('.chat-window-toggle')).not.toBeNull();
    expect((target.querySelector('.chat-get-started') as HTMLElement).hidden).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ action: 'loadPreviousSession' });
  });

  it('sends chatInput and sessionId under the default keys, with no extra initial messages', async () => {
    const { target, calls } = mount({ loadPreviousSession: false }, () => json({ output: 'ok' }));
    expect(target.querySelectorAll('.chat-message:not(.chat-message-typing)')).toHaveLength(0);
    await sendText(target, 'hello');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.action).toBe('sendMessage');
    expect(body.chatInput).toBe('hello');
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(8);
  });

  it('honours custom chatInputKey and chatSessionKey', async () => {
    const { target, calls } = mount(
      { loadPreviousSession: false, chatInputKey: 'q', chatSessionKey: 'sid', sessionId: 's-1' },
      () => json({ output: 'ok' }),
    );
    await sendText(target, 'hi');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({ action: 'sendMessage', q: 'hi', sid: 's-1' });
    expect(body.chatInput).toBeUndefined();
  });

  it('has no Powered-by footer and no branding text', () => {
    const { target } = mount();
    expect(target.textContent ?? '').not.toMatch(/powered by/i);
    expect(target.textContent ?? '').not.toMatch(/n8n/i);
    expect(target.querySelector('.chat-footer-text')).toBeNull();
  });

  it('shows the welcome screen first when asked, and Get Started opens the conversation', async () => {
    const { target } = mount({ showWelcomeScreen: true, loadPreviousSession: false, mode: 'fullscreen' });
    const welcome = target.querySelector('.chat-get-started') as HTMLElement;
    expect(welcome.hidden).toBe(false);
    expect((target.querySelector('.chat-messages-list') as HTMLElement).hidden).toBe(true);
    expect((target.querySelector('.chat-footer') as HTMLElement).hidden).toBe(true);
    (target.querySelector('.chat-get-started-button') as HTMLButtonElement).click();
    expect(welcome.hidden).toBe(true);
    expect((target.querySelector('.chat-messages-list') as HTMLElement).hidden).toBe(false);
    expect((target.querySelector('.chat-footer') as HTMLElement).hidden).toBe(false);
  });

  it('fullscreen mode is open at once', () => {
    const { target } = mount({ mode: 'fullscreen', loadPreviousSession: false });
    expect((target.querySelector('.chat-window') as HTMLElement).hidden).toBe(false);
    expect(target.querySelector('.chat-window-toggle')).toBeNull();
  });

  it('shows initialMessages as bot messages when there is no history', async () => {
    const { target } = mount({ initialMessages: ['Hi there', 'Ask me'], mode: 'fullscreen' });
    await flush();
    const bots = target.querySelectorAll('.chat-message-from-bot:not(.chat-message-typing)');
    expect(Array.from(bots).map((b) => b.textContent)).toEqual(['Hi there', 'Ask me']);
  });

  it('shows the previous session in the n8n reply shape and skips initialMessages', async () => {
    const { target } = mount({ initialMessages: ['Welcome'], mode: 'fullscreen' }, () =>
      json({
        data: [
          { id: ['langchain', 'schema', 'HumanMessage'], kwargs: { content: 'earlier question' } },
          { id: ['langchain', 'schema', 'AIMessage'], kwargs: { content: 'earlier answer' } },
        ],
      }),
    );
    await flush();
    await flush();
    const all = target.querySelectorAll('.chat-message:not(.chat-message-typing)');
    expect(Array.from(all).map((m) => m.textContent)).toEqual(['earlier question', 'earlier answer']);
    expect(all[0]?.classList.contains('chat-message-from-user')).toBe(true);
    expect(all[1]?.classList.contains('chat-message-from-bot')).toBe(true);
  });

  it('uses messageHistory without asking the server', async () => {
    const { target, calls } = mount({
      mode: 'fullscreen',
      messageHistory: [{ id: '1', sender: 'user', text: 'given' }],
    });
    await flush();
    expect(calls).toHaveLength(0);
    expect(target.querySelector('.chat-message-from-user')?.textContent).toBe('given');
  });

  it('disabled keeps the input off', () => {
    const { target } = mount({ disabled: true, mode: 'fullscreen', loadPreviousSession: false });
    expect(textarea(target).disabled).toBe(true);
    expect((target.querySelector('.chat-input-send-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('throws a clear error when the target is missing', () => {
    expect(() => createChat({ webhookUrl: WEBHOOK, target: '#nope' })).toThrow(/#nope/);
  });
});

describe('i18n merge', () => {
  it('keeps our defaults for strings the page did not set', () => {
    const merged = mergeStrings({ title: 'Support', repostButton: 'Again' });
    expect(merged.title).toBe('Support');
    expect(merged.repostButton).toBe('Again');
    expect(merged.inputPlaceholder).toBe(DEFAULT_STRINGS.inputPlaceholder);
    expect(merged.footer).toBe('');
  });

  it('ignores values that are not strings', () => {
    const merged = mergeStrings({ title: 5 as unknown as string });
    expect(merged.title).toBe(DEFAULT_STRINGS.title);
  });

  it('shows the merged strings in the page', () => {
    const { target } = mount({
      mode: 'fullscreen',
      loadPreviousSession: false,
      i18n: { en: { title: 'Help desk', inputPlaceholder: 'Say it' } },
    });
    expect(target.querySelector('.chat-heading-title')?.textContent).toBe('Help desk');
    expect(textarea(target).placeholder).toBe('Say it');
    expect(target.querySelector('.chat-subtitle')?.textContent).toBe(DEFAULT_STRINGS.subtitle);
  });
});

describe('session id', () => {
  async function sessionOf(options: Partial<ChatOptions>): Promise<string> {
    const { target, calls } = mount({ loadPreviousSession: false, mode: 'fullscreen', ...options }, () =>
      json({ output: 'ok' }),
    );
    await sendText(target, 'x');
    return JSON.parse(String(calls[0]?.init.body)).sessionId as string;
  }

  it('prefers the option over the URL fragment', async () => {
    window.history.replaceState(null, '', '/#sessionId=from-fragment');
    expect(await sessionOf({ sessionId: 'from-option' })).toBe('from-option');
    expect(window.location.hash).toBe('#sessionId=from-option');
  });

  it('takes the URL fragment when there is no option', async () => {
    window.history.replaceState(null, '', '/#sessionId=from-fragment');
    expect(await sessionOf({})).toBe('from-fragment');
  });

  it('makes a uuid and writes it to the fragment with replaceState', async () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    const id = await sessionOf({});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(window.location.hash).toBe(`#sessionId=${id}`);
    expect(spy).toHaveBeenCalled();
  });

  it('keeps other fragment keys when it writes its own', async () => {
    window.history.replaceState(null, '', '/#theme=dark');
    const id = await sessionOf({});
    const params = new URLSearchParams(window.location.hash.slice(1));
    expect(params.get('theme')).toBe('dark');
    expect(params.get('sessionId')).toBe(id);
  });

  it('newSession starts a new id and clears the messages', async () => {
    const { chat, target, calls } = mount(
      { loadPreviousSession: false, mode: 'fullscreen', sessionId: 'first' },
      () => json({ output: 'answer' }),
    );
    await sendText(target, 'one');
    expect(target.querySelectorAll('.chat-message:not(.chat-message-typing)').length).toBe(2);
    chat.newSession('second');
    expect(target.querySelectorAll('.chat-message:not(.chat-message-typing)').length).toBe(0);
    await sendText(target, 'two');
    expect(JSON.parse(String(calls[1]?.init.body)).sessionId).toBe('second');
  });
});

describe('memory only storage', () => {
  it('never reads localStorage, sessionStorage or a cookie', async () => {
    const throwing = {
      get() {
        throw new Error('storage must not be touched');
      },
    };
    const originals = {
      local: Object.getOwnPropertyDescriptor(window, 'localStorage'),
      session: Object.getOwnPropertyDescriptor(window, 'sessionStorage'),
    };
    Object.defineProperty(window, 'localStorage', { ...throwing, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { ...throwing, configurable: true });
    const cookieBefore = document.cookie;
    try {
      const { target, calls } = mount({ mode: 'fullscreen' }, () => json({ output: 'ok', data: [] }));
      await flush();
      await sendText(target, 'hello');
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(document.cookie).toBe(cookieBefore);
    } finally {
      if (originals.local) Object.defineProperty(window, 'localStorage', originals.local);
      if (originals.session) Object.defineProperty(window, 'sessionStorage', originals.session);
    }
  });
});

describe('events', () => {
  it('setInputValue, focusInput and blurInput drive the input', () => {
    const { chat, target } = mount({ mode: 'fullscreen', loadPreviousSession: false });
    chat.events.emit('setInputValue', 'typed for you');
    expect(textarea(target).value).toBe('typed for you');
    chat.events.emit('focusInput');
    expect(document.activeElement).toBe(textarea(target));
    chat.events.emit('blurInput');
    expect(document.activeElement).not.toBe(textarea(target));
  });

  it('close shuts the window and the toggle opens it again', () => {
    const { chat, target } = mount({ loadPreviousSession: false, showWindowCloseButton: true });
    const panel = target.querySelector('.chat-window') as HTMLElement;
    (target.querySelector('.chat-window-toggle') as HTMLButtonElement).click();
    expect(panel.hidden).toBe(false);
    const closed = vi.fn();
    chat.events.on('close', closed);
    (target.querySelector('.chat-close-button') as HTMLButtonElement).click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(panel.hidden).toBe(true);
  });

  it('scrollToBottom moves the list to its end', () => {
    const { chat, target } = mount({ mode: 'fullscreen', loadPreviousSession: false });
    const list = target.querySelector('.chat-messages-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
    chat.events.emit('scrollToBottom');
    expect(list.scrollTop).toBe(480);
  });

  it('off and the returned function remove a handler', () => {
    const { chat } = mount({ mode: 'fullscreen', loadPreviousSession: false });
    const a = vi.fn();
    const b = vi.fn();
    const stop = chat.events.on('close', a);
    chat.events.on('close', b);
    stop();
    chat.events.emit('close');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unmount removes the widget from the page', () => {
    const { chat, target } = mount({ mode: 'fullscreen', loadPreviousSession: false });
    chat.unmount();
    expect(target.querySelector('.chat-layout')).toBeNull();
  });
});
