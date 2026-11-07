import { type BlobTracker, clear, el } from '../dom';
import type { ChatStrings } from '../index';
import { renderMarkdown } from '../markdown';
import { createActions } from './actions';
import { type ButtonsDeps, parseButtonsMessage, renderButtonsMessage } from './buttons';
import { fileChip } from './files';

export interface BotMessage {
  el: HTMLElement;
  text(): string;
  set(text: string): void;
  append(text: string): void;
  /** the message is complete: a buttons message turns into buttons */
  close(): void;
  remove(): void;
}

export interface UserMessage {
  el: HTMLElement;
  remove(): void;
}

export interface MessagesOptions {
  strings: ChatStrings;
  enableMessageActions: boolean;
  blobs: BlobTracker;
  buttons: ButtonsDeps;
  onRepost(text: string): void;
  onReuse(text: string): void;
}

export interface Messages {
  /** the scrolling list, `aria-live="polite"` */
  el: HTMLElement;
  addUser(text: string, files?: File[]): UserMessage;
  addBot(text?: string): BotMessage;
  addError(text: string): HTMLElement;
  setTyping(show: boolean): void;
  scrollToBottom(): void;
  /** remove every message (a new session) */
  reset(): void;
  count(): number;
}

export function createMessages(options: MessagesOptions): Messages {
  const list = el('div', 'chat-messages-list', undefined, {
    'aria-live': 'polite',
    role: 'log',
    tabindex: '0',
  });
  const typing = el('div', 'chat-message chat-message-from-bot chat-message-typing', [
    el('span', 'chat-message-typing-circle'),
    el('span', 'chat-message-typing-circle'),
    el('span', 'chat-message-typing-circle'),
  ]);
  typing.hidden = true;
  typing.setAttribute('aria-hidden', 'true');
  list.appendChild(typing);

  function place(message: HTMLElement): void {
    list.insertBefore(message, typing);
    scrollToBottom();
  }

  function scrollToBottom(): void {
    list.scrollTop = list.scrollHeight;
  }

  return {
    el: list,
    addUser(text, files) {
      const message = el('div', 'chat-message chat-message-from-user');
      const body = el('div', 'chat-message-markdown');
      renderMarkdown(body, text);
      message.appendChild(body);
      if (files && files.length > 0) {
        const row = el('div', 'chat-message-files');
        for (const file of files) row.appendChild(fileChip(file, options.blobs));
        message.appendChild(row);
      }
      if (options.enableMessageActions) {
        message.appendChild(
          createActions({
            strings: options.strings,
            text,
            onRepost: options.onRepost,
            onReuse: options.onReuse,
          }),
        );
      }
      place(message);
      return { el: message, remove: () => message.remove() };
    },
    addBot(initial = '') {
      const message = el('div', 'chat-message chat-message-from-bot');
      const body = el('div', 'chat-message-markdown');
      message.appendChild(body);
      let text = '';
      const set = (next: string) => {
        text = next;
        renderMarkdown(body, text);
        scrollToBottom();
      };
      if (initial) set(initial);
      place(message);
      return {
        el: message,
        text: () => text,
        set,
        append: (more) => set(text + more),
        close() {
          const parsed = parseButtonsMessage(text);
          if (parsed) {
            clear(message);
            renderButtonsMessage(message, parsed, options.buttons);
          }
        },
        remove: () => message.remove(),
      };
    },
    addError(text) {
      const message = el('div', 'chat-message chat-message-from-bot chat-message-error', undefined, {
        role: 'alert',
      });
      message.appendChild(el('div', 'chat-message-markdown', [text]));
      place(message);
      return message;
    },
    setTyping(show) {
      typing.hidden = !show;
      if (show) scrollToBottom();
    },
    scrollToBottom,
    reset() {
      for (const node of Array.from(list.querySelectorAll('.chat-message:not(.chat-message-typing)')))
        node.remove();
      typing.hidden = true;
    },
    count: () => list.querySelectorAll('.chat-message:not(.chat-message-typing)').length,
  };
}
