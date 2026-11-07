import { marked, type Token, type Tokens } from 'marked';
import { highlightInto } from './highlight';

/**
 * Markdown to DOM. The marked lexer gives tokens; each is turned into elements with createElement and text
 * nodes. Raw HTML in the message prints as text, a link keeps only http, https and mailto, and an image
 * becomes a link and never loads.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The href to use, or undefined when the scheme is not http, https or mailto (relative links have no scheme). */
export function safeHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** marked leaves entities in text tokens as written; decode the common ones to plain characters. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function textNode(value: string): Text {
  return document.createTextNode(value);
}

function inline(tokens: Token[] | undefined, parent: Node): void {
  if (!tokens) return;
  for (const token of tokens) inlineToken(token, parent);
}

function link(href: string | undefined, parent: Node): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'chat-link';
  if (href) {
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  parent.appendChild(a);
  return a;
}

function inlineToken(token: Token, parent: Node): void {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) inline(t.tokens, parent);
      else parent.appendChild(textNode(decodeEntities(t.text)));
      return;
    }
    case 'escape':
      parent.appendChild(textNode((token as Tokens.Escape).text));
      return;
    case 'strong':
    case 'em':
    case 'del': {
      const node = document.createElement(token.type);
      inline((token as Tokens.Strong).tokens, node);
      parent.appendChild(node);
      return;
    }
    case 'codespan': {
      const code = document.createElement('code');
      code.className = 'chat-inline-code';
      code.textContent = (token as Tokens.Codespan).text;
      parent.appendChild(code);
      return;
    }
    case 'br':
      parent.appendChild(document.createElement('br'));
      return;
    case 'link': {
      const t = token as Tokens.Link;
      const a = link(safeHref(t.href), parent);
      if (t.title) a.title = t.title;
      if (t.tokens && t.tokens.length > 0) inline(t.tokens, a);
      else a.appendChild(textNode(t.text));
      return;
    }
    case 'image': {
      // never an image element: a link to the picture, so nothing loads without a click
      const t = token as Tokens.Image;
      const href = safeHref(t.href);
      const label = t.text?.trim() ? decodeEntities(t.text) : t.href;
      if (href) link(href, parent).appendChild(textNode(label));
      else parent.appendChild(textNode(label));
      return;
    }
    case 'checkbox':
      parent.appendChild(textNode((token as Tokens.Checkbox).checked ? '[x] ' : '[ ] '));
      return;
    case 'html':
      // raw HTML prints as text
      parent.appendChild(textNode((token as Tokens.HTML).raw));
      return;
    default: {
      const t = token as { tokens?: Token[]; raw?: string; text?: string };
      if (t.tokens && t.tokens.length > 0) inline(t.tokens, parent);
      else parent.appendChild(textNode(decodeEntities(t.text ?? t.raw ?? '')));
    }
  }
}

function blocks(tokens: Token[] | undefined, parent: Node): void {
  if (!tokens) return;
  for (const token of tokens) blockToken(token, parent);
}

function blockToken(token: Token, parent: Node): void {
  switch (token.type) {
    case 'space':
    case 'def':
      return;
    case 'paragraph': {
      const p = document.createElement('p');
      inline((token as Tokens.Paragraph).tokens, p);
      parent.appendChild(p);
      return;
    }
    case 'text': {
      // a loose text token inside a list item or a quote
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) inline(t.tokens, parent);
      else parent.appendChild(textNode(decodeEntities(t.text)));
      return;
    }
    case 'heading': {
      const t = token as Tokens.Heading;
      const h = document.createElement(`h${Math.min(6, Math.max(1, t.depth))}`);
      inline(t.tokens, h);
      parent.appendChild(h);
      return;
    }
    case 'hr':
      parent.appendChild(document.createElement('hr'));
      return;
    case 'blockquote': {
      const q = document.createElement('blockquote');
      blocks((token as Tokens.Blockquote).tokens, q);
      parent.appendChild(q);
      return;
    }
    case 'list': {
      const t = token as Tokens.List;
      const list = document.createElement(t.ordered ? 'ol' : 'ul');
      if (t.ordered && typeof t.start === 'number' && t.start !== 1)
        list.setAttribute('start', String(t.start));
      for (const item of t.items) {
        const li = document.createElement('li');
        blocks(item.tokens, li);
        list.appendChild(li);
      }
      parent.appendChild(list);
      return;
    }
    case 'code': {
      const t = token as Tokens.Code;
      const pre = document.createElement('pre');
      pre.className = 'chat-code-block';
      const code = document.createElement('code');
      const lang = t.lang?.trim().split(/\s+/)[0]?.toLowerCase();
      if (lang) code.className = `language-${lang.replace(/[^a-z0-9_+-]/g, '')}`;
      highlightInto(code, t.text, lang);
      pre.appendChild(code);
      parent.appendChild(pre);
      return;
    }
    case 'table': {
      const t = token as Tokens.Table;
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of t.header) {
        const th = document.createElement('th');
        inline(cell.tokens, th);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of t.rows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          inline(cell.tokens, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      parent.appendChild(table);
      return;
    }
    case 'html': {
      // a raw HTML block prints as text
      const p = document.createElement('p');
      p.appendChild(textNode((token as Tokens.HTML).raw.replace(/\n+$/, '')));
      parent.appendChild(p);
      return;
    }
    default: {
      const t = token as { tokens?: Token[]; raw?: string; text?: string };
      const p = document.createElement('p');
      if (t.tokens && t.tokens.length > 0) inline(t.tokens, p);
      else p.appendChild(textNode(decodeEntities(t.text ?? t.raw ?? '')));
      parent.appendChild(p);
    }
  }
}

/** Replace the children of `target` with the rendered markdown of `source`. */
export function renderMarkdown(target: HTMLElement, source: string): void {
  while (target.firstChild) target.removeChild(target.firstChild);
  let tokens: Token[];
  try {
    tokens = marked.lexer(source);
  } catch {
    target.appendChild(textNode(source));
    return;
  }
  blocks(tokens, target);
}
