import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterFiles, mimeAllowed } from '../src/components/files';
import { type ChatInstance, type ChatOptions, createChat } from '../src/index';

const WEBHOOK = 'http://localhost:3000/webhook/abc/chat';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let mounted: ChatInstance[] = [];

function mount(
  options: Partial<ChatOptions> = {},
  reply: () => Response | Promise<Response> = () => json({ output: 'ok' }),
) {
  const bodies: string[] = [];
  const fetchFake = vi.fn(async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    return reply();
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const chat = createChat({
    webhookUrl: WEBHOOK,
    target,
    mode: 'fullscreen',
    loadPreviousSession: false,
    sessionId: 's',
    fetch: fetchFake as unknown as typeof fetch,
    ...options,
  });
  mounted.push(chat);
  const area = target.querySelector('textarea') as HTMLTextAreaElement;
  return { chat, target, area, bodies, fetchFake };
}

function key(area: HTMLTextAreaElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  area.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const chat of mounted) chat.unmount();
  mounted = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('keyboard', () => {
  it('Enter sends and clears the input', async () => {
    const { area, bodies, target } = mount();
    area.value = 'hello';
    const event = key(area, 'Enter');
    expect(event.defaultPrevented).toBe(true);
    await flush();
    await flush();
    expect(bodies).toHaveLength(1);
    expect(area.value).toBe('');
    expect(target.querySelector('.chat-message-from-user')?.textContent).toBe('hello');
  });

  it('Shift+Enter is a newline and sends nothing', async () => {
    const { area, bodies } = mount();
    area.value = 'line one';
    const event = key(area, 'Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    await flush();
    expect(bodies).toHaveLength(0);
    expect(area.value).toBe('line one');
  });

  it('does not send an empty message or one while composing', async () => {
    const { area, bodies } = mount();
    area.value = '   ';
    key(area, 'Enter');
    area.value = 'composing';
    key(area, 'Enter', { isComposing: true });
    await flush();
    expect(bodies).toHaveLength(0);
  });

  it('ArrowUp and ArrowDown walk the earlier user messages', async () => {
    const { area } = mount();
    for (const text of ['first', 'second', 'third']) {
      area.value = text;
      key(area, 'Enter');
      await flush();
      await flush();
    }
    expect(area.value).toBe('');
    key(area, 'ArrowUp');
    expect(area.value).toBe('third');
    key(area, 'ArrowUp');
    expect(area.value).toBe('second');
    key(area, 'ArrowUp');
    key(area, 'ArrowUp');
    expect(area.value).toBe('first');
    key(area, 'ArrowDown');
    expect(area.value).toBe('second');
    key(area, 'ArrowDown');
    key(area, 'ArrowDown');
    expect(area.value).toBe('');
  });

  it('ArrowUp does not replace text the person is typing', async () => {
    const { area } = mount({ messageHistory: [{ id: '1', sender: 'user', text: 'old' }] });
    area.value = 'draft';
    const event = key(area, 'ArrowUp');
    expect(event.defaultPrevented).toBe(false);
    expect(area.value).toBe('draft');
  });

  it('walks messages from messageHistory too', () => {
    const { area } = mount({
      messageHistory: [
        { id: '1', sender: 'user', text: 'old one' },
        { id: '2', sender: 'bot', text: 'reply' },
      ],
    });
    key(area, 'ArrowUp');
    expect(area.value).toBe('old one');
  });
});

describe('disabled state and live region', () => {
  it('the message list is a polite live region', () => {
    const { target } = mount();
    expect(target.querySelector('.chat-messages-list')?.getAttribute('aria-live')).toBe('polite');
  });

  it('the input is disabled while a reply is pending and sends once', async () => {
    let release: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { area, bodies, target } = mount({}, () => pending);
    area.value = 'slow';
    key(area, 'Enter');
    await flush();
    expect(area.disabled).toBe(true);
    expect((target.querySelector('.chat-input-send-button') as HTMLButtonElement).disabled).toBe(true);
    expect((target.querySelector('.chat-message-typing') as HTMLElement).hidden).toBe(false);
    key(area, 'Enter');
    release(json({ output: 'done' }));
    await flush();
    await flush();
    await flush();
    expect(bodies).toHaveLength(1);
    expect(area.disabled).toBe(false);
    expect((target.querySelector('.chat-message-typing') as HTMLElement).hidden).toBe(true);
  });

  it('disabled: true sends nothing, even by the send button', async () => {
    const { area, bodies, target } = mount({ disabled: true });
    area.value = 'x';
    (target.querySelector('.chat-input-send-button') as HTMLButtonElement).click();
    await flush();
    expect(bodies).toHaveLength(0);
  });
});

describe('files', () => {
  const png = () => new File(['x'], 'pic.png', { type: 'image/png' });
  const pdf = () => new File(['x'], 'doc.pdf', { type: 'application/pdf' });

  function attach(target: HTMLElement, files: File[]): void {
    const input = target.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  it('filters by MIME type, extension and wildcard', () => {
    expect(mimeAllowed(png(), 'image/*')).toBe(true);
    expect(mimeAllowed(pdf(), 'image/*')).toBe(false);
    expect(mimeAllowed(pdf(), 'image/*, application/pdf')).toBe(true);
    expect(mimeAllowed(pdf(), '.pdf')).toBe(true);
    expect(mimeAllowed(pdf(), '*')).toBe(true);
    expect(mimeAllowed(pdf(), '')).toBe(true);
    expect(mimeAllowed(pdf(), undefined)).toBe(true);
    expect(filterFiles([png(), pdf()], 'application/pdf').map((f) => f.name)).toEqual(['doc.pdf']);
  });

  it('is hidden when uploads are not allowed', () => {
    const { target } = mount();
    expect(target.querySelector('input[type="file"]')).toBeNull();
    expect(target.querySelector('.chat-input-file-button')).toBeNull();
  });

  it('shows chips for accepted files only, and delete removes a chip', () => {
    const { target } = mount({ allowFileUploads: true, allowedFilesMimeTypes: 'application/pdf' });
    attach(target, [png(), pdf()]);
    const chips = target.querySelectorAll('.chat-files .chat-file');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.querySelector('.chat-file-name')?.textContent).toBe('doc.pdf');
    (chips[0] as HTMLElement).querySelector<HTMLButtonElement>('.chat-file-delete')?.click();
    expect(target.querySelectorAll('.chat-files .chat-file')).toHaveLength(0);
    expect((target.querySelector('.chat-files') as HTMLElement).hidden).toBe(true);
  });

  it('previews an image through a blob: URL and revokes it on delete', () => {
    const create = vi.fn(() => 'blob:http://localhost:3000/abc');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const { target } = mount({ allowFileUploads: true });
    attach(target, [png()]);
    const img = target.querySelector('.chat-file-preview') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:http://localhost:3000/abc');
    (target.querySelector('.chat-file-delete') as HTMLButtonElement).click();
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost:3000/abc');
    vi.unstubAllGlobals();
  });

  it('revokes the preview URLs of the chips it replaces, and the picker ones after a send', async () => {
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    let n = 0;
    const live = new Set<string>();
    Object.assign(URL, {
      createObjectURL: () => {
        n += 1;
        live.add(`blob:test/${n}`);
        return `blob:test/${n}`;
      },
      revokeObjectURL: (url: string) => {
        live.delete(url);
      },
    });
    try {
      const { target, area } = mount({ allowFileUploads: true });
      attach(target, [png()]);
      attach(target, [new File(['y'], 'b.png', { type: 'image/png' })]);
      // two chips on screen and two live URLs: the first render's URL was revoked
      expect(target.querySelectorAll('.chat-files .chat-file-preview')).toHaveLength(2);
      expect(live.size).toBe(2);
      area.value = 'look';
      key(area, 'Enter');
      await flush();
      await flush();
      expect(target.querySelectorAll('.chat-files .chat-file')).toHaveLength(0);
      // only the previews inside the sent message are left
      expect(live.size).toBe(target.querySelectorAll('.chat-message-from-user .chat-file-preview').length);
    } finally {
      Object.assign(URL, { createObjectURL: real.create, revokeObjectURL: real.revoke });
    }
  });

  it('puts the accept list on the file input', () => {
    const { target } = mount({ allowFileUploads: true, allowedFilesMimeTypes: 'image/*,.csv' });
    expect(target.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/*,.csv');
  });
});

describe('message actions', () => {
  it('has no actions unless enableMessageActions is set', async () => {
    const { area, target } = mount();
    area.value = 'hi';
    key(area, 'Enter');
    await flush();
    await flush();
    expect(target.querySelector('.chat-message-actions')).toBeNull();
  });

  it('reuse puts the text back in the input, repost sends it again', async () => {
    const { area, target, bodies } = mount(
      { enableMessageActions: true, i18n: { en: { repostButton: 'Again!', reuseButton: 'Edit it' } } },
      () => json({ output: 'ok' }),
    );
    area.value = 'my words';
    key(area, 'Enter');
    await flush();
    await flush();
    const reuse = target.querySelector('.chat-message-action-reuse') as HTMLButtonElement;
    const repost = target.querySelector('.chat-message-action-repost') as HTMLButtonElement;
    expect(reuse.textContent).toBe('Edit it');
    expect(repost.textContent).toBe('Again!');
    reuse.click();
    expect(area.value).toBe('my words');
    area.value = '';
    repost.click();
    await flush();
    await flush();
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1] ?? '{}').chatInput).toBe('my words');
  });

  it('shows actions on user messages only', async () => {
    const { area, target } = mount({ enableMessageActions: true });
    area.value = 'hi';
    key(area, 'Enter');
    await flush();
    await flush();
    expect(target.querySelectorAll('.chat-message-from-user .chat-message-actions')).toHaveLength(1);
    expect(target.querySelectorAll('.chat-message-from-bot .chat-message-actions')).toHaveLength(0);
  });
});

describe('text safety', () => {
  it('writes user text as text: a tag in a message makes no element', async () => {
    const { area, target } = mount();
    area.value = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    key(area, 'Enter');
    await flush();
    await flush();
    expect(target.querySelectorAll('img, script')).toHaveLength(0);
    expect(target.querySelector('.chat-message-from-user')?.textContent).toContain('<img src=x');
  });

  it('writes the bot reply through the markdown renderer: no raw HTML', async () => {
    const { area, target } = mount({}, () => json({ output: '**fine** <script>alert(1)</script>' }));
    area.value = 'q';
    key(area, 'Enter');
    await flush();
    await flush();
    expect(target.querySelectorAll('script')).toHaveLength(0);
    expect(target.querySelector('.chat-message-from-bot strong')?.textContent).toBe('fine');
  });
});
