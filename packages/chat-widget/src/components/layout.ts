import { button, el } from '../dom';
import type { ChatEvents, ChatStrings } from '../index';
import { createHeader } from './header';

export interface Layout {
  /** the element appended to the target */
  root: HTMLElement;
  /** where the welcome screen or the message list goes */
  body: HTMLElement;
  /** where the input goes */
  footer: HTMLElement;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function toggleIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M4 4h16v12H8l-4 4V4z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/** Window mode: a toggle button and a closable panel. Fullscreen mode: the panel fills the target. */
export function createLayout(options: {
  mode: 'window' | 'fullscreen';
  strings: ChatStrings;
  showClose: boolean;
  events: ChatEvents;
}): Layout {
  const windowMode = options.mode === 'window';
  const root = el('div', `chat-layout chat-layout-${options.mode}`);
  const panel = el('div', 'chat-window');
  const header = createHeader({
    strings: options.strings,
    showClose: windowMode && options.showClose,
    onClose: () => options.events.emit('close'),
  });
  const body = el('div', 'chat-body');
  const footer = el('div', 'chat-footer');
  panel.append(header, body, footer);
  // a text line from the options, written as text; empty by default (no branding line)
  if (options.strings.footer) panel.appendChild(el('div', 'chat-footer-text', [options.strings.footer]));
  root.appendChild(panel);

  let open = !windowMode;
  panel.hidden = !open;

  const layout: Layout = {
    root,
    body,
    footer,
    setOpen(next) {
      if (!windowMode) return;
      open = next;
      panel.hidden = !open;
      root.classList.toggle('chat-layout-open', open);
    },
    isOpen: () => open,
  };

  if (windowMode) {
    const toggle = button('chat-window-toggle', '', options.strings.title);
    toggle.appendChild(toggleIcon());
    toggle.addEventListener('click', () => {
      if (layout.isOpen()) options.events.emit('close');
      else layout.setOpen(true);
    });
    root.appendChild(toggle);
    options.events.on('close', () => layout.setOpen(false));
  }
  return layout;
}
