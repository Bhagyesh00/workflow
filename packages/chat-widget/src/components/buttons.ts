import { hasWebhookOrigin } from '../api';
import { button, el } from '../dom';
import { renderMarkdown } from '../markdown';

export interface ButtonSpec {
  text: string;
  link: string;
  type?: string;
}

export interface ButtonsMessage {
  text: string;
  buttons: ButtonSpec[];
  blockUserInput: boolean;
}

/** `{type:'with-buttons', text, buttons:[{text, link, type}], blockUserInput}`; anything else is not a buttons message. */
export function parseButtonsMessage(raw: string): ButtonsMessage | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'with-buttons' || !Array.isArray(record.buttons)) return null;
  const buttons: ButtonSpec[] = [];
  for (const entry of record.buttons) {
    if (!entry || typeof entry !== 'object') continue;
    const { text, link, type } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || typeof link !== 'string') continue;
    buttons.push({ text, link, type: typeof type === 'string' ? type : undefined });
  }
  return {
    text: typeof record.text === 'string' ? record.text : '',
    buttons,
    blockUserInput: record.blockUserInput === true,
  };
}

export interface ButtonsDeps {
  webhookUrl: string;
  /** runs the GET of the link (and reads its stream); rejects on a failure */
  onClick(spec: ButtonSpec): Promise<void>;
  /** called with true when the message blocks the input, false once a button was used */
  onBlock(blocked: boolean): void;
}

/**
 * Renders a buttons message into `target`. A button shows only when its link has the webhook's origin: the
 * request carries the page and auth tokens, so no other host may be called.
 */
export function renderButtonsMessage(target: HTMLElement, message: ButtonsMessage, deps: ButtonsDeps): void {
  while (target.firstChild) target.removeChild(target.firstChild);
  const text = el('div', 'chat-message-markdown');
  renderMarkdown(text, message.text);
  target.appendChild(text);

  const allowed = message.buttons.filter((spec) => hasWebhookOrigin(spec.link, deps.webhookUrl));
  if (allowed.length === 0) return;
  const row = el('div', 'chat-buttons');
  const nodes: HTMLButtonElement[] = [];
  for (const spec of allowed) {
    const kind = spec.type === 'secondary' ? 'secondary' : 'primary';
    const node = button(`chat-button chat-button-${kind}`, spec.text);
    node.addEventListener('click', async () => {
      for (const other of nodes) other.disabled = true;
      try {
        await deps.onClick(spec);
        if (message.blockUserInput) deps.onBlock(false);
      } catch {
        for (const other of nodes) other.disabled = false;
      }
    });
    nodes.push(node);
    row.appendChild(node);
  }
  target.appendChild(row);
  if (message.blockUserInput) deps.onBlock(true);
}
