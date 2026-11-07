// Embeddable chat widget for the Chat Trigger. Vanilla TypeScript, no Shadow DOM, DOM writes through createElement and textContent only.
// Built as an IIFE (global `WorkflowChat`) for the hosted page and embeds, and imported as ES by the editor.
// Without this import Vite writes no dist/chat.css.
import './chat.css';
import { ChatRequestError, createApi, errorTextOf, hasWebhookOrigin, parseReply } from './api';
import type { ButtonSpec } from './components/buttons';
import { createInput } from './components/input';
import { createLayout } from './components/layout';
import { type BotMessage, createMessages } from './components/messages';
import { createWelcome } from './components/welcome';
import { createBlobTracker } from './dom';
import { createEvents } from './events';
import { ERROR_MESSAGES, mergeStrings } from './i18n';
import { newSessionId, resolveSessionId, writeFragmentSession } from './session';
import { readStream } from './stream';

export type {
  ChatFrame,
  ChatFrameMetadata,
  ChatPageConfig,
  ChatResponseMode,
} from '@workflow/workflow';

/** Texts the widget shows; `i18n.en` merges over our own defaults. */
export interface ChatStrings {
  title: string;
  subtitle: string;
  footer: string;
  getStarted: string;
  inputPlaceholder: string;
  closeButtonTooltip: string;
  repostButton: string;
  reuseButton: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  files?: File[];
}

/** What `beforeMessageSent` may return to change one request: another URL (same origin rules apply) or extra headers. */
export interface ChatRequestOverride {
  url?: string;
  headers?: Record<string, string>;
}

export interface ChatOptions {
  webhookUrl: string;
  webhookConfig?: { method?: 'POST' | 'GET'; headers?: Record<string, string> };
  /** Default `#chat`. */
  target?: string | HTMLElement;
  /** Default `window`. */
  mode?: 'window' | 'fullscreen';
  showWindowCloseButton?: boolean;
  /** Default false. */
  showWelcomeScreen?: boolean;
  /** Default true. */
  loadPreviousSession?: boolean;
  /** Order: this option, the URL fragment `#sessionId=...`, a new uuid. Kept in memory only. */
  sessionId?: string;
  /** Default `chatInput`. */
  chatInputKey?: string;
  /** Default `sessionId`. */
  chatSessionKey?: string;
  defaultLanguage?: 'en';
  initialMessages?: string[];
  messageHistory?: ChatMessage[];
  metadata?: Record<string, unknown>;
  i18n?: { en?: Partial<ChatStrings> };
  disabled?: boolean;
  allowFileUploads?: boolean;
  allowedFilesMimeTypes?: string;
  enableStreaming?: boolean;
  enableMessageActions?: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: the contract lets the hook return nothing or an override
  beforeMessageSent?(message: string): void | ChatRequestOverride | Promise<void | ChatRequestOverride>;
  afterMessageSent?(message: string, response?: unknown): void;
  /** Seam for the editor demo and tests; `credentials: 'omit'` is always set on top of it. */
  fetch?: typeof fetch;
}

/** Events of the widget's bus and their payloads (`undefined`: no payload). */
export interface ChatEventMap {
  scrollToBottom: undefined;
  focusInput: undefined;
  blurInput: undefined;
  setInputValue: string;
  close: undefined;
}

export type ChatEventName = keyof ChatEventMap;

export type ChatEventHandler<K extends ChatEventName> = (payload: ChatEventMap[K]) => void;

export interface ChatEvents {
  /** Returns a function that removes the handler. */
  on<K extends ChatEventName>(event: K, handler: ChatEventHandler<K>): () => void;
  off<K extends ChatEventName>(event: K, handler: ChatEventHandler<K>): void;
  emit<K extends ChatEventName>(
    event: K,
    ...payload: ChatEventMap[K] extends undefined ? [] : [ChatEventMap[K]]
  ): void;
}

export interface ChatInstance {
  unmount(): void;
  events: ChatEvents;
  newSession(id?: string): void;
}

function resolveTarget(target: string | HTMLElement | undefined): HTMLElement {
  if (typeof target === 'object' && target !== null) return target;
  const selector = target ?? '#chat';
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Chat target "${selector}" was not found on the page`);
  return found;
}

export function createChat(options: ChatOptions): ChatInstance {
  const strings = mergeStrings(options.i18n?.en);
  const target = resolveTarget(options.target);
  const events = createEvents();
  const blobs = createBlobTracker();
  const api = createApi({
    webhookUrl: options.webhookUrl,
    webhookConfig: options.webhookConfig,
    chatInputKey: options.chatInputKey ?? 'chatInput',
    chatSessionKey: options.chatSessionKey ?? 'sessionId',
    fetch: options.fetch,
  });

  let sessionId = resolveSessionId(options.sessionId);
  /** where the next message goes after a `wait` frame (the webhook's own origin only) */
  let resumeUrl: string | undefined;
  let blocked = false;
  let disposed = false;
  const userHistory: string[] = [];

  const layout = createLayout({
    mode: options.mode ?? 'window',
    strings,
    showClose: options.showWindowCloseButton ?? false,
    events,
  });

  function applyDisabled(): void {
    input.setDisabled(Boolean(options.disabled) || blocked);
  }

  const messages = createMessages({
    strings,
    enableMessageActions: options.enableMessageActions ?? false,
    blobs,
    buttons: {
      webhookUrl: options.webhookUrl,
      onClick: (spec) => runButton(spec),
      onBlock: (value) => {
        blocked = value;
        applyDisabled();
      },
    },
    onRepost: (text) => {
      input.setValue(text);
      void input.submit();
    },
    onReuse: (text) => {
      input.setValue(text);
      input.focus();
    },
  });

  const input = createInput({
    strings,
    allowFileUploads: options.allowFileUploads ?? false,
    allowedMimeTypes: options.allowedFilesMimeTypes,
    blobs,
    history: () => userHistory,
    onSend: (text, files) => deliver(text, files),
  });

  function showConversation(): void {
    welcome.hidden = true;
    messages.el.hidden = false;
    layout.footer.hidden = false;
  }

  const welcome = createWelcome({
    strings,
    onStart: () => {
      showConversation();
      input.focus();
    },
  });

  layout.body.append(welcome, messages.el);
  layout.footer.appendChild(input.el);
  if (options.showWelcomeScreen ?? false) {
    welcome.hidden = false;
    messages.el.hidden = true;
    layout.footer.hidden = true;
  } else {
    showConversation();
  }
  applyDisabled();
  target.appendChild(layout.root);

  function streamHandlers() {
    const open = new Map<string, BotMessage>();
    const texts: string[] = [];
    let first = true;
    const reveal = () => {
      if (first) {
        first = false;
        messages.setTyping(false);
      }
    };
    return {
      texts,
      handlers: {
        open(key: string) {
          reveal();
          open.set(key, messages.addBot());
        },
        append(key: string, text: string) {
          reveal();
          open.get(key)?.append(text);
        },
        close(key: string) {
          const message = open.get(key);
          if (!message) return;
          message.close();
          texts.push(message.text());
          open.delete(key);
        },
        error(text: string) {
          reveal();
          messages.addError(text);
        },
        wait(url: string) {
          // the next POST carries the page and auth headers: only the webhook's own origin may get it
          if (hasWebhookOrigin(url, options.webhookUrl)) resumeUrl = url;
        },
      },
    };
  }

  /** Reads one reply and returns what `afterMessageSent` gets. Throws a ChatRequestError for a failure. */
  async function consume(response: Response, htmlIsError: boolean): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      throw new ChatRequestError(
        errorTextOf(response.status, await response.text().catch(() => ''), contentType),
      );
    }
    if (contentType.includes('ndjson')) {
      const stream = streamHandlers();
      try {
        await readStream(response, stream.handlers);
      } finally {
        messages.setTyping(false);
      }
      return stream.texts.join('\n\n');
    }
    const raw = await response.text();
    const reply = parseReply(raw, contentType);
    messages.setTyping(false);
    if (reply.kind === 'html') {
      if (htmlIsError) throw new ChatRequestError(ERROR_MESSAGES.htmlReply);
      return undefined;
    }
    if (reply.text) messages.addBot(reply.text).close();
    try {
      return JSON.parse(raw);
    } catch {
      return reply.text;
    }
  }

  async function deliver(text: string, files: File[]): Promise<boolean> {
    const userMessage = messages.addUser(text, files);
    userHistory.push(text);
    messages.setTyping(true);
    try {
      let override: ChatRequestOverride | undefined;
      try {
        const hook = await options.beforeMessageSent?.(text);
        override = typeof hook === 'object' && hook !== null ? hook : undefined;
      } catch {
        override = undefined;
      }
      const response = await api.send({
        sessionId,
        message: text,
        files: files.length > 0 ? files : undefined,
        metadata: options.metadata,
        url: resumeUrl,
        override,
      });
      // the stored resume URL is used once
      if (response.ok) resumeUrl = undefined;
      const result = await consume(response, true);
      try {
        options.afterMessageSent?.(text, result);
      } catch {
        // a failing hook does not undo the message
      }
      return true;
    } catch (error) {
      // the text stays in the input so the person can send it again
      userMessage.remove();
      userHistory.pop();
      messages.setTyping(false);
      messages.addError(error instanceof ChatRequestError ? error.message : ERROR_MESSAGES.failed);
      return false;
    }
  }

  async function runButton(spec: ButtonSpec): Promise<void> {
    messages.setTyping(true);
    try {
      await consume(await api.get(spec.link), false);
    } catch (error) {
      messages.setTyping(false);
      messages.addError(error instanceof ChatRequestError ? error.message : ERROR_MESSAGES.failed);
      throw error;
    }
  }

  async function loadInitial(): Promise<void> {
    const show = (list: { sender: 'user' | 'bot'; text: string }[]) => {
      for (const item of list) {
        if (item.sender === 'user') {
          messages.addUser(item.text);
          userHistory.push(item.text);
        } else {
          messages.addBot(item.text).close();
        }
      }
    };
    const supplied = options.messageHistory ?? [];
    if (supplied.length > 0) {
      show(supplied);
      return;
    }
    if (options.loadPreviousSession ?? true) {
      const id = sessionId;
      const previous = await api.loadPrevious(id);
      if (disposed || id !== sessionId) return;
      if (previous.length > 0) {
        show(previous);
        return;
      }
    }
    show((options.initialMessages ?? []).map((text) => ({ sender: 'bot' as const, text })));
  }
  void loadInitial();

  const off = [
    events.on('scrollToBottom', () => messages.scrollToBottom()),
    events.on('focusInput', () => input.focus()),
    events.on('blurInput', () => input.blur()),
    events.on('setInputValue', (value) => input.setValue(typeof value === 'string' ? value : '')),
  ];

  return {
    events,
    unmount() {
      disposed = true;
      for (const stop of off) stop();
      blobs.revokeAll();
      layout.root.remove();
    },
    newSession(id) {
      sessionId = id?.trim() ? id : newSessionId();
      writeFragmentSession(sessionId);
      resumeUrl = undefined;
      blocked = false;
      applyDisabled();
      userHistory.length = 0;
      messages.reset();
      void loadInitial();
    },
  };
}
