/**
 * State of the canvas chat (P5-59): the session id, the messages shown, and the node a step run asked
 * the chat to stop at. The widget keeps its own DOM; this store lets the panel mount it again (a tab
 * switch) with the same session and history. No token and no URL lives here.
 */
import { create } from 'zustand';

export interface ChatLine {
  id: string;
  sender: 'user' | 'bot';
  text: string;
}

const MAX_LINES = 200;
let lineSeq = 0;

export function newChatSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** the first characters of a session id, for the panel's header */
export function shortSessionId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

export interface ChatState {
  sessionId: string;
  messages: ChatLine[];
  /** a step run downstream of the chat trigger: the next messages run up to this node */
  destinationNode: string | null;
  /** true once this session sent a message (a later message may answer a waiting run) */
  hasSent: boolean;
  addMessage(sender: ChatLine['sender'], text: string): void;
  setDestination(node: string | null): void;
  markSent(): void;
  /** clears the messages and the destination and starts a new id; returns it */
  newSession(): string;
}

export const useChatStore = create<ChatState>()((set) => ({
  sessionId: newChatSessionId(),
  messages: [],
  destinationNode: null,
  hasSent: false,

  addMessage(sender, text) {
    set((s) => ({
      messages: [...s.messages, { id: `chat-${++lineSeq}`, sender, text }].slice(-MAX_LINES),
    }));
  },
  setDestination(node) {
    set({ destinationNode: node });
  },
  markSent() {
    set({ hasSent: true });
  },
  newSession() {
    const sessionId = newChatSessionId();
    set({ sessionId, messages: [], destinationNode: null, hasSent: false });
    return sessionId;
  },
}));
