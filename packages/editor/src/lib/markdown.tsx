/**
 * Minimal Markdown for sticky notes and markdown file previews (P3-14), rendered to React elements
 * (never to HTML strings), so content cannot inject markup: raw HTML and images stay text.
 * Supports headings, paragraphs, lists, fenced code, blockquotes, rules, tables, bold, italic,
 * strikethrough, inline code and http(s)/mailto links.
 */
import type { ReactNode } from 'react';

/**
 * Each alternative stops at the next character that could start another match of itself: a label
 * never holds `[` and a link target never holds `[`, so a long line of `[`, `![` or `[a](` is
 * scanned once, not once per start position (linear, not quadratic).
 */
const INLINE =
  /(!\[[^[\]]*\]\([^)\s[]+\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^[\]]+\]\([^)\s[]+\))/g;

/** blockquotes nest at most this deep; deeper markers stay text */
const MAX_QUOTE_DEPTH = 8;

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
    // images are never loaded: the markdown is shown as text
    if (part.startsWith('![')) return <span key={key}>{part}</span>;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
      return <del key={key}>{part.slice(2, -2)}</del>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return <code key={key}>{part.slice(1, -1)}</code>;
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      if (part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^[\]]+)\]\(([^)\s[]+)\)$/);
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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
/** one cell of a table's separator row: `---`, `:--`, `--:` or `:-:` */
const SEPARATOR_CELL = /^:?-+:?$/;

type Align = 'left' | 'center' | 'right' | undefined;

/** `| a | b |` -> ['a', 'b'] (an escaped `\|` stays in its cell) */
function tableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (separator === undefined || !header.includes('|') || !separator.includes('|')) return false;
  const cells = tableCells(separator);
  return cells.every((cell) => SEPARATOR_CELL.test(cell)) && tableCells(header).length === cells.length;
}

function alignment(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return left ? 'left' : undefined;
}

const TABLE_CELL = 'border border-current/20 px-2 py-1';

function renderTable(header: string[], aligns: Align[], rows: string[][], key: string): ReactNode {
  // rows and cells never reorder, so their position is a stable key (as the other blocks here)
  const headCells: ReactNode[] = [];
  for (const [n, text] of header.entries()) {
    headCells.push(
      <th key={`${key}-h${n}`} className={`${TABLE_CELL} font-semibold`} style={{ textAlign: aligns[n] }}>
        {renderInline(text, `${key}-h${n}`)}
      </th>,
    );
  }
  const bodyRows: ReactNode[] = [];
  for (const [r, row] of rows.entries()) {
    const cells: ReactNode[] = [];
    for (let n = 0; n < header.length; n++) {
      const cellKey = `${key}-r${r}-${n}`;
      cells.push(
        <td key={cellKey} className={TABLE_CELL} style={{ textAlign: aligns[n] }}>
          {renderInline(row[n] ?? '', cellKey)}
        </td>,
      );
    }
    bodyRows.push(<tr key={`${key}-r${r}`}>{cells}</tr>);
  }
  return (
    <div key={key} className="my-2 overflow-x-auto">
      <table className="border-collapse text-left">
        <thead>
          <tr>{headCells}</tr>
        </thead>
        <tbody>{bodyRows}</tbody>
      </table>
    </div>
  );
}

function renderBlocks(lines: string[], prefix: string, quoteDepth: number): ReactNode[] {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const nextKey = (kind: string) => `${prefix}${kind}-${blocks.length}`;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = nextKey('p');
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
    const key = nextKey('l');
    const items: ReactNode[] = [];
    for (const [n, item] of list.items.entries()) {
      items.push(<li key={`${key}-${n}`}>{renderInline(item, `${key}-${n}`)}</li>);
    }
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE);
    // a backtick fence's info string has no backtick (else it is inline code)
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      flush();
      const marker = fence[1];
      const code: string[] = [];
      index++;
      while (index < lines.length) {
        const closing = lines[index].match(FENCE_CLOSE);
        if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) break;
        code.push(lines[index]);
        index++;
      }
      index++; // past the closing fence, or the end when it is unclosed
      const key = nextKey('c');
      blocks.push(
        <pre key={key} className="my-2 overflow-x-auto rounded bg-black/5 p-2 font-mono text-xs">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push(<hr key={nextKey('r')} className="my-3 border-current opacity-20" />);
      index++;
      continue;
    }

    if (quoteDepth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length) {
        const inner = lines[index].match(QUOTE);
        if (!inner) break;
        quoted.push(inner[1]);
        index++;
      }
      const key = nextKey('q');
      blocks.push(
        <blockquote key={key} className="my-2 border-l-2 border-current/40 pl-3 opacity-80">
          {renderBlocks(quoted, `${key}-`, quoteDepth + 1)}
        </blockquote>,
      );
      continue;
    }

    if (isTableStart(lines, index)) {
      flush();
      const header = tableCells(line);
      const aligns = tableCells(lines[index + 1]).map(alignment);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]));
        index++;
      }
      blocks.push(renderTable(header, aligns, rows, nextKey('t')));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const key = nextKey('h');
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
      flush();
    } else {
      flushList();
      paragraph.push(line);
    }
    index++;
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return <div className="wf-md">{renderBlocks(lines, '', 0)}</div>;
}
