/**
 * P5-56 hosted chat page (chat-page.ts): every value is escaped for its context, the page has no inline
 * handler and no storage, and its bootstrap mounts the widget with the page token from the blob.
 */
import { runInNewContext } from 'node:vm';
import type { ChatPageConfig } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { escapeForScript, renderChatPage } from '../src/nodes/trigger/chat-page';

const config = (overrides: Partial<ChatPageConfig> = {}): ChatPageConfig => ({
  webhookUrl: '/webhook/acme/chat-id/chat',
  pageToken: 'page.token',
  title: 'Support',
  subtitle: 'We answer fast',
  inputPlaceholder: 'Ask away',
  getStarted: 'New Conversation',
  initialMessages: ['Hi there!', 'How can I help?'],
  showWelcomeScreen: false,
  loadPreviousSession: false,
  allowFileUploads: false,
  allowedFilesMimeTypes: '*',
  enableStreaming: true,
  customCss: '',
  ...overrides,
});

const BLOB = /<script type="application\/json" id="chat-config">([^<]*)<\/script>/;

function blobOf(page: string): ChatPageConfig {
  const match = BLOB.exec(page);
  if (!match) throw new Error('no config blob');
  return JSON.parse(match[1]) as ChatPageConfig;
}

/** the inline bootstrap: the last script element */
function bootstrapOf(page: string): string {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return scripts[scripts.length - 1]?.[1] ?? '';
}

describe('escapeForScript', () => {
  it('escapes <, >, &, U+2028 and U+2029 and keeps the JSON value', () => {
    const value = { a: '</script><b>&amp;', line: 'one\u2028two\u2029three' };
    const escaped = escapeForScript(JSON.stringify(value));
    expect(escaped).not.toMatch(/[<>&\u2028\u2029]/);
    expect(escaped).toContain('\\u003c/script\\u003e');
    expect(escaped).toContain('\\u0026amp;');
    expect(escaped).toContain('\\u2028');
    expect(escaped).toContain('\\u2029');
    expect(JSON.parse(escaped)).toEqual(value);
  });
});

describe('renderChatPage', () => {
  it('writes a doctype page with the classic widget script, its styles and one config blob', () => {
    const page = renderChatPage(config());
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<script src="/chat-widget/chat.js"></script>');
    expect(page).not.toContain('type="module"');
    expect(page).toContain('<link rel="stylesheet" href="/chat-widget/chat.css">');
    expect(page.match(/id="chat-config"/g)).toHaveLength(1);
    expect(blobOf(page)).toEqual(config());
    expect(page).toContain('<title>Support</title>');
  });

  it('escapes a hostile title, initial message and custom CSS', () => {
    const hostile = config({
      title: '</title><script>alert(1)</script>',
      initialMessages: ['</script><img src=x onerror=alert(1)>', 'fine'],
      customCss: 'body{color:red}</style></script><script>alert(2)</script>',
    });
    const page = renderChatPage(hostile);
    // only the page's own three scripts close: blob, widget, bootstrap
    expect(page.match(/<\/script>/gi)).toHaveLength(3);
    expect(page.match(/<script/gi)).toHaveLength(3);
    expect(page).not.toContain('<img');
    expect(page).not.toContain('</style></script>');
    expect(page).toContain('<title>&#60;/title&#62;&#60;script&#62;alert(1)&#60;/script&#62;</title>');
    expect(blobOf(page)).toEqual(hostile);
  });

  it('escapes U+2028 and U+2029 in the blob', () => {
    const value = config({ subtitle: 'line\u2028break\u2029here' });
    const page = renderChatPage(value);
    expect(page).not.toMatch(/[\u2028\u2029]/);
    expect(blobOf(page).subtitle).toBe('line\u2028break\u2029here');
  });

  it('has no inline event handler, no storage and no cookie', () => {
    const page = renderChatPage(config({ authToken: 'auth.token', customCss: '.chat-header{color:red}' }));
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toContain('localStorage');
    expect(page).not.toContain('sessionStorage');
    expect(page).not.toMatch(/cookie/i);
  });

  it('bootstraps the widget full screen with the page token, the auth token and the custom CSS as text', () => {
    const page = renderChatPage(
      config({ authToken: 'auth.token', customCss: '.chat-header{color:red}</style>' }),
    );
    const blob = BLOB.exec(page)?.[1] ?? '';
    const appended: Array<{ textContent: string }> = [];
    const calls: Array<Record<string, unknown>> = [];
    const document = {
      getElementById: (id: string) => (id === 'chat-config' ? { textContent: blob } : null),
      createElement: (tag: string) => ({ tag, textContent: '' }),
      head: { appendChild: (el: { textContent: string }) => appended.push(el) },
    };
    const window = {
      location: { href: 'https://app.example.com/webhook/acme/chat-id/chat#sessionId=s1' },
      WorkflowChat: { createChat: (options: Record<string, unknown>) => calls.push(options) },
    };
    runInNewContext(bootstrapOf(page), { document, window, URL, JSON });

    expect(appended.map((el) => el.textContent)).toEqual(['.chat-header{color:red}</style>']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      webhookUrl: 'https://app.example.com/webhook/acme/chat-id/chat',
      webhookConfig: {
        method: 'POST',
        headers: { 'x-chat-page': 'page.token', 'x-auth-token': 'auth.token' },
      },
      target: '#chat',
      mode: 'fullscreen',
      initialMessages: ['Hi there!', 'How can I help?'],
      enableStreaming: true,
      loadPreviousSession: false,
      i18n: { en: { title: 'Support', subtitle: 'We answer fast', inputPlaceholder: 'Ask away' } },
    });
    // the session is the widget's: from the fragment, never from storage
    expect(calls[0]).not.toHaveProperty('sessionId');
  });

  it('sends no auth header without an auth token and adds no style without custom CSS', () => {
    const page = renderChatPage(config());
    const blob = BLOB.exec(page)?.[1] ?? '';
    const appended: unknown[] = [];
    const calls: Array<{ webhookConfig: { headers: Record<string, string> } }> = [];
    runInNewContext(bootstrapOf(page), {
      document: {
        getElementById: () => ({ textContent: blob }),
        createElement: () => ({}),
        head: { appendChild: (el: unknown) => appended.push(el) },
      },
      window: {
        location: { href: 'https://app.example.com/x' },
        WorkflowChat: { createChat: (o: never) => calls.push(o) },
      },
      URL,
      JSON,
    });
    expect(appended).toEqual([]);
    expect(calls[0]?.webhookConfig.headers).toEqual({ 'x-chat-page': 'page.token' });
  });
});
