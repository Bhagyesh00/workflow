/**
 * Minimal Markdown for sticky notes, rendered to React elements (never to HTML strings), so note
 * content cannot inject markup. Supports headings, paragraphs, lists, bold, italic, inline code
 * and http(s)/mailto links.
 */
import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function safeHref(href: string): string | null {
  try {
    const url = new URL(href, 'https://invalid.local');
    if (url.origin === 'https://invalid.local') return null;
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (!part) return null;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return <code key={key}>{part.slice(1, -1)}</code>;
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      if (part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      const href = safeHref(link[2]);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {link[1]}
        </a>
      ) : (
        <span key={key}>{link[1]}</span>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `p-${blocks.length}`;
    const content: ReactNode[] = [];
    for (const [n, line] of paragraph.entries()) {
      if (n > 0) content.push(<br key={`${key}-br-${n}`} />);
      content.push(...renderInline(line, `${key}-${n}`));
    }
    blocks.push(<p key={key}>{content}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = `l-${blocks.length}`;
    const items: ReactNode[] = [];
    for (const [n, item] of list.items.entries()) {
      items.push(<li key={`${key}-${n}`}>{renderInline(item, `${key}-${n}`)}</li>);
    }
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const key = `h-${blocks.length}`;
      const content = renderInline(heading[2], key);
      blocks.push(
        level === 1 ? (
          <h1 key={key}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={key}>{content}</h2>
        ) : (
          <h3 key={key}>{content}</h3>
        ),
      );
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="wf-md">{blocks}</div>;
}
