import { button, el } from '../dom';
import type { ChatStrings } from '../index';

/** Repost and reuse buttons under a user message (`enableMessageActions`). */
export function createActions(options: {
  strings: ChatStrings;
  text: string;
  onRepost(text: string): void;
  onReuse(text: string): void;
}): HTMLElement {
  const wrap = el('div', 'chat-message-actions');
  const repost = button(
    'chat-message-action chat-message-action-repost',
    options.strings.repostButton,
    options.strings.repostButton,
  );
  repost.addEventListener('click', () => options.onRepost(options.text));
  const reuse = button(
    'chat-message-action chat-message-action-reuse',
    options.strings.reuseButton,
    options.strings.reuseButton,
  );
  reuse.addEventListener('click', () => options.onReuse(options.text));
  wrap.append(repost, reuse);
  return wrap;
}
