import { button, el } from '../dom';
import type { ChatStrings } from '../index';

/** The welcome screen: the Get Started button that opens the conversation. */
export function createWelcome(options: { strings: ChatStrings; onStart(): void }): HTMLElement {
  const wrap = el('div', 'chat-get-started');
  const start = button('chat-get-started-button', options.strings.getStarted);
  start.addEventListener('click', options.onStart);
  wrap.appendChild(start);
  return wrap;
}
