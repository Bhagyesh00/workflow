import { button, el } from '../dom';
import type { ChatStrings } from '../index';

/** Title, subtitle and (window mode) the close button. */
export function createHeader(options: {
  strings: ChatStrings;
  showClose: boolean;
  onClose(): void;
}): HTMLElement {
  const header = el('div', 'chat-header');
  const heading = el('div', 'chat-heading');
  heading.appendChild(el('h1', 'chat-heading-title', [options.strings.title]));
  if (options.strings.subtitle) heading.appendChild(el('p', 'chat-subtitle', [options.strings.subtitle]));
  header.appendChild(heading);
  if (options.showClose) {
    const close = button('chat-close-button', '×', options.strings.closeButtonTooltip);
    close.addEventListener('click', options.onClose);
    header.appendChild(close);
  }
  return header;
}
