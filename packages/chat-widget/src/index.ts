// Embeddable chat widget for the Chat Trigger. Vanilla TypeScript, no Shadow DOM, DOM writes through createElement and textContent only.
// Built as an IIFE (global `WorkflowChat`) for the hosted page and embeds, and imported as ES by the editor.
// Without this import Vite writes no dist/chat.css.
import './chat.css';

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

export function createChat(options: ChatOptions): ChatInstance {
  void options;
  throw new Error('not implemented (L1)');
}
