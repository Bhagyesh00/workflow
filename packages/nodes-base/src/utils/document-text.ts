/**
 * The text of a document file (`@workflow/nodes-base/utils/document-text`), for the Assistant's `parse_file`
 * tool (P5-74): PDF through `pdfPages` (extract/pdf.ts), XLSX through the Extract From File sheet reader,
 * DOCX through `unzipBounded` (utils/archive.ts) and its XML, HTML stripped to text, text and markdown as
 * they are. Every container is read within the instance's decompression limits; a file it cannot or may
 * not read throws `DocumentTextError` with a text a person can act on. CSV, TSV and JSON are read by the
 * server itself (rows paged), not here.
 */
import type { InstanceLimits } from '@workflow/workflow';
import { XMLParser } from 'fast-xml-parser';
import * as XLSX from 'xlsx';
import { PdfReadError, pdfPages } from '../nodes/core/extract/pdf';
import { SpreadsheetError, spreadsheetRows } from '../nodes/core/extract/spreadsheet';
import { ArchiveError, unzipBounded } from './archive';

/** the document formats `documentText` reads */
export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'html' | 'text' | 'markdown';

export interface DocumentTextOptions {
  /** the instance's bounds: bytes a container may inflate to, its entries, the cells one sheet may span */
  limits: Pick<InstanceLimits, 'maxDecompressedBytes' | 'maxArchiveEntries' | 'maxSpreadsheetCells'>;
  /** PDF pages read from the start; 0 or unset reads every page */
  maxPages?: number;
  /** characters of text returned; longer text is cut and `truncated` set; unset keeps all of it */
  maxChars?: number;
}

export interface DocumentText {
  /** the document's text (PDF pages, sheets and paragraphs joined by blank lines) */
  text: string;
  /** true when `maxPages` or `maxChars` cut the text */
  truncated: boolean;
  /** pages read (PDF) or sheets read (XLSX); unset for the other formats */
  pages?: number;
}

/** a document that cannot or may not be read (damaged, encrypted, over a limit); the message is for a person */
export class DocumentTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTextError';
  }
}

/** sheets of one workbook read at most */
const MAX_SHEETS = 20;

/** The text of `bytes` read as `format`, within `options.limits`. Throws `DocumentTextError`. */
export async function documentText(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: DocumentTextOptions,
): Promise<DocumentText> {
  try {
    const read = await readText(bytes, format, options);
    return cut(read, options.maxChars);
  } catch (error) {
    if (error instanceof DocumentTextError) throw error;
    if (error instanceof PdfReadError || error instanceof ArchiveError || error instanceof SpreadsheetError) {
      throw new DocumentTextError(error.message);
    }
    throw new DocumentTextError(`The ${format} file could not be read: it is damaged or not in that format`);
  }
}

function cut(read: DocumentText, maxChars: number | undefined): DocumentText {
  if (maxChars === undefined || maxChars < 0 || read.text.length <= maxChars) return read;
  return { ...read, text: read.text.slice(0, maxChars), truncated: true };
}

async function readText(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: DocumentTextOptions,
): Promise<DocumentText> {
  switch (format) {
    case 'pdf':
      return readPdfText(bytes, options);
    case 'xlsx':
      return readWorkbookText(bytes, options);
    case 'docx':
      return readDocxText(bytes, options);
    case 'html':
      return readHtml(bytes);
    case 'text':
    case 'markdown':
      return { text: decodeUtf8(bytes), truncated: false };
    default:
      throw new DocumentTextError(`The format "${String(format)}" cannot be read as text`);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

async function readPdfText(bytes: Uint8Array, options: DocumentTextOptions): Promise<DocumentText> {
  const maxPages = Math.max(0, Math.floor(options.maxPages ?? 0));
  // one page past the cap tells whether the document has more
  const pages = await pdfPages(bytes, {
    maxPages: maxPages > 0 ? maxPages + 1 : 0,
    maxBytes: options.limits.maxDecompressedBytes,
  });
  const more = maxPages > 0 && pages.length > maxPages;
  const kept = more ? pages.slice(0, maxPages) : pages;
  return { text: kept.join('\n\n'), truncated: more, pages: kept.length };
}

function sheetNames(bytes: Uint8Array): string[] {
  try {
    return XLSX.read(bytes, { type: 'buffer', bookSheets: true }).SheetNames;
  } catch {
    throw new DocumentTextError('The file could not be read as XLSX: it is damaged or not in that format');
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

function readWorkbookText(bytes: Uint8Array, options: DocumentTextOptions): DocumentText {
  const { limits, maxChars } = options;
  // the first read checks the container and the size before the sheet list is read
  const first = spreadsheetRows(bytes, 'xlsx', { headerRow: false }, limits);
  const names = sheetNames(bytes);
  const blocks: string[] = [];
  let size = 0;
  let read = 0;
  let truncated = names.length > MAX_SHEETS;
  for (const [index, name] of names.slice(0, MAX_SHEETS).entries()) {
    const rows =
      index === 0 ? first : spreadsheetRows(bytes, 'xlsx', { headerRow: false, sheetName: name }, limits);
    const lines = rows.map((row) => {
      const cells = Array.isArray(row.row) ? row.row : [];
      return cells.map(cellText).join('\t');
    });
    const block = `## Sheet: ${name}\n${lines.join('\n')}`;
    blocks.push(block);
    read += 1;
    size += block.length + 2;
    if (maxChars !== undefined && size > maxChars) {
      truncated = truncated || read < names.length;
      break;
    }
  }
  return { text: blocks.join('\n\n'), truncated, pages: read };
}

type XmlNode = Record<string, unknown>;

/** the text of one `w:p` tree: runs of `w:t`, tabs and line breaks */
function paragraphText(children: unknown): string {
  if (!Array.isArray(children)) return '';
  let text = '';
  for (const child of children as XmlNode[]) {
    for (const [key, value] of Object.entries(child)) {
      if (key === '#text') text += String(value);
      else if (key === 'w:tab') text += '\t';
      else if (key === 'w:br' || key === 'w:cr') text += '\n';
      else if (key !== ':@' && key !== 'w:pPr' && key !== 'w:rPr') text += paragraphText(value);
    }
  }
  return text;
}

/** every `w:p` below `nodes`, in document order; stops once `budget` characters are collected */
function collectParagraphs(nodes: unknown, out: string[], budget: { left: number }): void {
  if (!Array.isArray(nodes) || budget.left <= 0) return;
  for (const node of nodes as XmlNode[]) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'w:p') {
        const text = paragraphText(value);
        out.push(text);
        budget.left -= text.length + 2;
      } else if (key !== ':@') {
        collectParagraphs(value, out, budget);
      }
    }
  }
}

async function readDocxText(bytes: Uint8Array, options: DocumentTextOptions): Promise<DocumentText> {
  const { limits } = options;
  const files = await unzipBounded(bytes, {
    maxBytes: limits.maxDecompressedBytes,
    maxEntries: limits.maxArchiveEntries,
  });
  const main = files.find((file) => file.name === 'word/document.xml');
  if (!main) throw new DocumentTextError('The file is not a DOCX document: word/document.xml is missing');
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    processEntities: true,
    trimValues: false,
    parseTagValue: false,
  });
  const tree: unknown = parser.parse(Buffer.from(main.data).toString('utf8'));
  const paragraphs: string[] = [];
  const budget = { left: options.maxChars ?? Number.POSITIVE_INFINITY };
  collectParagraphs(tree, paragraphs, budget);
  return { text: paragraphs.join('\n\n'), truncated: false };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** characters of HTML read at most (an attachment at n8n's 7.5 MB limit fits); a longer page is cut */
export const MAX_HTML_CHARS = 8 * 1024 * 1024;
/** elements whose content is never shown */
const HIDDEN_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);
/** closing tags that end a line (`<br>` too) */
const LINE_END_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'section',
  'article',
  'pre',
  'ul',
  'ol',
]);
/** characters of a tag name looked at; a longer name is no tag this reader knows */
const TAG_NAME_CHARS = 16;

function readHtml(bytes: Uint8Array): DocumentText {
  const html = decodeUtf8(bytes);
  const truncated = html.length > MAX_HTML_CHARS;
  return { text: htmlToText(truncated ? html.slice(0, MAX_HTML_CHARS) : html), truncated };
}

/** a letter, a digit or `-` */
function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45
  );
}

/** the tag name that starts at `from`, lower case */
function tagNameAt(html: string, from: number): string {
  let end = from;
  while (end < html.length && end - from < TAG_NAME_CHARS && isNameChar(html.charCodeAt(end))) end += 1;
  return html.slice(from, end).toLowerCase();
}

/** the index after the `</name ...>` that closes a hidden element, searched from `from`; -1 when there is none */
function hiddenElementEnd(html: string, name: string, from: number): number {
  let at = from;
  for (;;) {
    const close = html.indexOf('</', at);
    if (close < 0) return -1;
    const nameEnd = close + 2 + name.length;
    if (html.slice(close + 2, nameEnd).toLowerCase() === name && !isNameChar(html.charCodeAt(nameEnd))) {
      const end = html.indexOf('>', nameEnd);
      return end < 0 ? -1 : end + 1;
    }
    at = close + 2;
  }
}

/**
 * The visible text of an HTML page: scripts, styles and comments dropped, block tags become line breaks.
 * One pass with `indexOf` that only moves forward, so hostile input costs linear time (no regex runs on
 * the markup): an unclosed comment or hidden element hides the rest of the page, as in a browser, and a
 * `<` with no `>` after it is text.
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, open));
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close < 0) break;
      parts.push(' ');
      at = close + 3;
      continue;
    }
    const end = html.indexOf('>', open + 1);
    if (end < 0) {
      parts.push(html.slice(open));
      break;
    }
    const closing = html.charCodeAt(open + 1) === 47;
    const name = tagNameAt(html, open + (closing ? 2 : 1));
    if (!closing && HIDDEN_ELEMENTS.has(name)) {
      const after = hiddenElementEnd(html, name, end + 1);
      if (after < 0) break;
      parts.push(' ');
      at = after;
      continue;
    }
    parts.push((closing && LINE_END_TAGS.has(name)) || (!closing && name === 'br') ? '\n' : ' ');
    at = end + 1;
  }
  return decodeEntities(parts.join(''))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
