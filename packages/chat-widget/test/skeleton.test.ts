import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChatEventMap,
  type ChatFrame,
  type ChatInstance,
  type ChatOptions,
  type ChatPageConfig,
  createChat,
} from '../src/index';
import tokens from './css-tokens.json';

describe('chat-widget skeleton', () => {
  it('exports createChat with the final signature', () => {
    expect(typeof createChat).toBe('function');
    expect(createChat.length).toBe(1);
    const typed: (options: ChatOptions) => ChatInstance = createChat;
    expect(typed).toBe(createChat);
  });

  it('accepts every option of the contract', () => {
    const options: ChatOptions = {
      webhookUrl: 'https://example.test/webhook/abc/chat',
      webhookConfig: { method: 'POST', headers: { 'x-chat-page': 't' } },
      target: '#chat',
      mode: 'fullscreen',
      showWindowCloseButton: true,
      showWelcomeScreen: false,
      loadPreviousSession: true,
      sessionId: 's1',
      chatInputKey: 'chatInput',
      chatSessionKey: 'sessionId',
      defaultLanguage: 'en',
      initialMessages: ['Hi'],
      messageHistory: [{ id: 'm1', sender: 'bot', text: 'Hello' }],
      metadata: { a: 1 },
      i18n: { en: { title: 'Chat', repostButton: 'Repost' } },
      disabled: false,
      allowFileUploads: true,
      allowedFilesMimeTypes: 'image/*',
      enableStreaming: true,
      enableMessageActions: true,
      beforeMessageSent: () => ({ headers: { 'x-extra': '1' } }),
      afterMessageSent: () => undefined,
      fetch: globalThis.fetch,
    };
    expect(options.mode).toBe('fullscreen');
    const events: (keyof ChatEventMap)[] = [
      'scrollToBottom',
      'focusInput',
      'blurInput',
      'setInputValue',
      'close',
    ];
    expect(events).toHaveLength(5);
  });

  it('shares the frame and page types with @workflow/workflow', () => {
    const frames: ChatFrame[] = [
      {
        type: 'begin',
        metadata: { nodeId: 'n', nodeName: 'Agent', runIndex: 0, itemIndex: 0, timestamp: 1 },
      },
      {
        type: 'item',
        content: 'x',
        metadata: { nodeId: 'n', nodeName: 'Agent', runIndex: 0, itemIndex: 0, timestamp: 2 },
      },
      { type: 'wait', resumeUrl: 'https://example.test/webhook-waiting/1' },
    ];
    const page: Pick<ChatPageConfig, 'webhookUrl' | 'enableStreaming'> = {
      webhookUrl: '/w',
      enableStreaming: true,
    };
    expect(frames.map((f) => f.type)).toEqual(['begin', 'item', 'wait']);
    expect(page.enableStreaming).toBe(true);
  });

  it('holds the 115 theming variable names, names only', () => {
    expect(tokens).toHaveLength(115);
    expect(new Set(tokens).size).toBe(115);
    for (const name of tokens) expect(name).toMatch(/^--chat--[a-z0-9-]+$/);
  });

  it('keeps chat.css as a source file the entry imports', () => {
    const entry = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(entry).toContain("import './chat.css';");
    expect(entry).not.toContain('innerHTML');
  });
});
