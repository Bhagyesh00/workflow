/**
 * Text out of a file or an item's JSON for the document loaders: CSV, DOCX, EPUB, JSON, PDF and
 * plain text, each bounded by the instance limits.
 *
 * Archives (DOCX, EPUB) are read only through `unzipBounded` into memory; an EPUB href is resolved
 * inside that in-memory file map and nowhere else. XML is parsed with entity expansion off, so an
 * entity bomb stays text; only the five predefined entities and numeric references are decoded, by
 * a single pass that cannot expand.
 */
import { PdfReadError, pdfPages } from '@workflow/nodes-base/extract/pdf';
import { ArchiveError, type ArchiveFile, unzipBounded } from '@workflow/nodes-base/utils/archive';
import { type BaseContext, type DataObject, NodeOperationError } from '@workflow/workflow';
import { XMLParser } from 'fast-xml-parser';

/** the Default Data Loader's `loader` option values (n8n's names) */
export type LoaderKind =
  | 'auto'
  | 'csvLoader'
  | 'docxLoader'
  | 'epubLoader'
  | 'jsonLoader'
  | 'pdfLoader'
  | 'textLoader';

export interface FileTextOptions {
  loader: LoaderKind;
  /** CSV separator */
  separator?: string;
  /** CSV column to read; all columns when unset */
  column?: string;
  /** JSON pointers to read; the whole value when unset */
  pointers?: string[];
  /** PDF: one source per page (default true) */
  splitPages?: boolean;
}

export interface TextSource {
  text: string;
  metadata: DataObject;
}

/** `a.b: value` lines for every leaf; keeps keys so retrieval has context. */
export function flattenJson(value: unknown, prefix = '', depth = 0, lines: string[] = []): string[] {
  if (depth > 32) return lines;
  if (value === null || value === undefined) return lines;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries())
      flattenJson(v, prefix ? `${prefix}[${i}]` : `[${i}]`, depth + 1, lines);
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as DataObject))
      flattenJson(v, prefix ? `${prefix}.${k}` : k, depth + 1, lines);
  } else {
    lines.push(prefix ? `${prefix}: ${String(value)}` : String(value));
  }
  return lines;
}

/** RFC 4180 CSV parsing (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// mime types

const MIME_LOADERS: Record<string, Exclude<LoaderKind, 'auto'>> = {
  'application/pdf': 'pdfLoader',
  'text/csv': 'csvLoader',
  'application/epub+zip': 'epubLoader',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docxLoader',
  'text/plain': 'textLoader',
  'text/mdx': 'textLoader',
  'text/md': 'textLoader',
  'text/markdown': 'textLoader',
  'application/json': 'jsonLoader',
};

const EXTENSION_LOADERS: Record<string, Exclude<LoaderKind, 'auto'>> = {
  pdf: 'pdfLoader',
  csv: 'csvLoader',
  epub: 'epubLoader',
  docx: 'docxLoader',
  txt: 'textLoader',
  md: 'textLoader',
  mdx: 'textLoader',
  markdown: 'textLoader',
  json: 'jsonLoader',
};

/** other text types that were readable as plain text before the format loaders existed */
const TEXT_MIME = /^text\/|^application\/(xml|x-yaml|yaml|x-ndjson|markdown|javascript|x-sh|sql)/;

const LOADER_LABELS: Record<Exclude<LoaderKind, 'auto'>, string> = {
  csvLoader: 'CSV',
  docxLoader: 'Docx',
  epubLoader: 'EPub',
  jsonLoader: 'JSON',
  pdfLoader: 'PDF',
  textLoader: 'Text',
};

function detectLoader(mimeType: string | undefined, fileName: string | undefined) {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const exact = MIME_LOADERS[mime];
  if (exact) return exact;
  if (/json/.test(mime)) return 'jsonLoader';
  if (/csv/.test(mime)) return 'csvLoader';
  if (TEXT_MIME.test(mime)) return 'textLoader';
  if (mime === '' || mime === 'application/octet-stream') {
    const extension = /\.([A-Za-z0-9]+)$/.exec(fileName ?? '')?.[1]?.toLowerCase();
    if (extension) return EXTENSION_LOADERS[extension];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// XML

const parser = new XMLParser({
  preserveOrder: true,
  processEntities: false,
  htmlEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type XmlNode = Record<string, unknown>;

const localName = (tag: string) => tag.slice(tag.indexOf(':') + 1);
const MAX_XML_DEPTH = 200;

function parseXml(text: string): XmlNode[] {
  return parser.parse(text) as XmlNode[];
}

/** a node's tag name (the one key that is neither text nor attributes) */
function tagOf(node: XmlNode): string | undefined {
  for (const key of Object.keys(node)) if (key !== ':@' && key !== '#text') return key;
  return undefined;
}

function attributesOf(node: XmlNode): Record<string, string> {
  const raw = node[':@'];
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

function attribute(node: XmlNode, name: string): string | undefined {
  for (const [key, value] of Object.entries(attributesOf(node))) {
    if (localName(key.replace(/^@_/, '')) === name && typeof value === 'string') return value;
  }
  return undefined;
}

function childrenOf(node: XmlNode, tag: string): XmlNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

/** the first descendant element named `name` (local name), depth first */
function findAll(nodes: XmlNode[], name: string, found: XmlNode[] = [], depth = 0): XmlNode[] {
  if (depth > MAX_XML_DEPTH) return found;
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (localName(tag) === name) found.push(node);
    findAll(childrenOf(node, tag), name, found, depth + 1);
  }
  return found;
}

/** `&amp; &lt; &gt; &quot; &apos;` and numeric references, once; any other `&name;` stays as written */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos));/g,
    (match, dec, hex, name) => {
      if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name as string]!;
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    },
  );
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'blockquote',
  'pre',
  'section',
  'article',
  'ul',
  'ol',
  'table',
  'hr',
]);
const SKIPPED_TAGS = new Set(['script', 'style', 'head', 'title']);

/** the text of an (X)HTML tree; block elements start a new line, script and style are dropped */
function htmlText(nodes: XmlNode[]): string {
  let out = '';
  const walk = (list: XmlNode[], depth: number) => {
    if (depth > MAX_XML_DEPTH) return;
    for (const node of list) {
      if (typeof node['#text'] === 'string') {
        out += decodeEntities(node['#text']).replace(/\s+/g, ' ');
        continue;
      }
      const tag = tagOf(node);
      if (!tag) continue;
      const name = localName(tag).toLowerCase();
      if (SKIPPED_TAGS.has(name)) continue;
      const block = BLOCK_TAGS.has(name);
      if (block && out !== '' && !out.endsWith('\n')) out += '\n';
      walk(childrenOf(node, tag), depth + 1);
      if (block && out !== '' && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(nodes, 0);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** text of the Word paragraphs of word/document.xml: runs joined, tabs and breaks kept */
function wordText(nodes: XmlNode[]): string {
  const paragraphs: string[] = [];
  const runText = (list: XmlNode[], depth: number): string => {
    if (depth > MAX_XML_DEPTH) return '';
    let text = '';
    for (const node of list) {
      if (typeof node['#text'] === 'string') {
        text += decodeEntities(node['#text']);
        continue;
      }
      const tag = tagOf(node);
      if (!tag) continue;
      const name = localName(tag);
      if (name === 'tab') text += '\t';
      else if (name === 'br' || name === 'cr') text += '\n';
      else if (name === 'p') paragraphs.push(runText(childrenOf(node, tag), depth + 1));
      else text += runText(childrenOf(node, tag), depth + 1);
    }
    return text;
  };
  const top = runText(nodes, 0);
  if (top.trim() !== '') paragraphs.push(top);
  return paragraphs.join('\n');
}

// ---------------------------------------------------------------------------------------------
// formats

const decoder = new TextDecoder();

function csvSources(text: string, separator: string, column: string | undefined): TextSource[] {
  const [header, ...rows] = parseCsv(text, separator);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  if (column === undefined || column === '') {
    return rows.map((row, i) => ({
      text: names.map((h, c) => `${h}: ${row[c] ?? ''}`).join('\n'),
      metadata: { line: i + 2 },
    }));
  }
  const at = names.indexOf(column.trim());
  if (at < 0) throw new Error(`Column "${column}" is not in the CSV`);
  return rows.map((row, i) => ({ text: row[at] ?? '', metadata: { line: i + 2 } }));
}

/** the value at an RFC 6901 pointer; own properties only */
function resolvePointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  const path = pointer.startsWith('/') || pointer === '' ? pointer : `/${pointer}`;
  let current: unknown = root;
  if (path === '') return { found: true, value: current };
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) return { found: false };
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as DataObject)[key];
    } else return { found: false };
  }
  return { found: true, value: current };
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : flattenJson(value).join('\n');
}

function pointerSources(value: unknown, pointers: string[]): TextSource[] {
  const sources: TextSource[] = [];
  for (const pointer of pointers) {
    const hit = resolvePointer(value, pointer);
    if (hit.found && hit.value !== undefined && hit.value !== null) {
      sources.push({ text: valueText(hit.value), metadata: { pointer } });
    }
  }
  return sources;
}

/** The texts of an item's JSON, one per JSON pointer when pointers are given. */
export function itemJsonToSources(value: unknown, pointers?: string[]): TextSource[] {
  const list = (pointers ?? []).map((p) => p.trim()).filter((p) => p !== '');
  if (list.length > 0) return pointerSources(value, list);
  return [{ text: valueText(value), metadata: {} }];
}

function jsonSources(text: string, pointers: string[] | undefined): TextSource[] {
  const parsed: unknown = JSON.parse(text);
  const list = (pointers ?? []).map((p) => p.trim()).filter((p) => p !== '');
  if (list.length > 0) return pointerSources(parsed, list);
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => ({ text: flattenJson(entry).join('\n'), metadata: { index } }));
  }
  return [{ text: flattenJson(parsed).join('\n'), metadata: {} }];
}

function findFile(files: ArchiveFile[], name: string): ArchiveFile | undefined {
  return files.find((f) => f.name === name);
}

/** resolve `href` against the folder of `base` inside the archive; undefined if it leaves the archive */
function resolveInArchive(base: string, href: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\/|^\\/.test(href)) return undefined;
  let clean = href.split('#')[0]!.split('?')[0]!;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return undefined;
  }
  const parts = base.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function docxText(files: ArchiveFile[]): TextSource[] {
  const document = findFile(files, 'word/document.xml');
  if (!document) throw new Error('The file is not a Word document: word/document.xml is missing');
  return [{ text: wordText(parseXml(decoder.decode(document.data))), metadata: {} }];
}

function epubSources(files: ArchiveFile[]): TextSource[] {
  const container = findFile(files, 'META-INF/container.xml');
  if (!container) throw new Error('The file is not an EPUB: META-INF/container.xml is missing');
  const rootfile = findAll(parseXml(decoder.decode(container.data)), 'rootfile')[0];
  const opfPath = rootfile && attribute(rootfile, 'full-path');
  const opfName = opfPath ? resolveInArchive('x', opfPath) : undefined;
  const opf = opfName ? findFile(files, opfName) : undefined;
  if (!opfName || !opf) throw new Error('The file is not an EPUB: the package document is missing');
  const tree = parseXml(decoder.decode(opf.data));

  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of findAll(tree, 'item')) {
    const id = attribute(item, 'id');
    const href = attribute(item, 'href');
    if (id !== undefined && href !== undefined) {
      manifest.set(id, { href, type: attribute(item, 'media-type') ?? '' });
    }
  }
  const sources: TextSource[] = [];
  // A spine can point at one chapter again and again: read each file once. The text of distinct files
  // is never longer than their decompressed bytes, which unzipBounded already limits.
  const seen = new Set<string>();
  for (const ref of findAll(tree, 'itemref')) {
    const entry = manifest.get(attribute(ref, 'idref') ?? '');
    if (!entry || !/^(application\/xhtml\+xml|text\/html)$/i.test(entry.type)) continue;
    const name = resolveInArchive(opfName, entry.href);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const file = findFile(files, name);
    if (!file) continue;
    const text = htmlText(parseXml(decoder.decode(file.data)));
    if (text !== '') sources.push({ text, metadata: { chapter: sources.length + 1 } });
  }
  return sources;
}

/** The texts of a binary file, per the selected (or detected) loader. */
export async function fileToSources(
  ctx: BaseContext,
  itemIndex: number,
  file: { bytes: Uint8Array; mimeType?: string; fileName?: string },
  options: FileTextOptions,
): Promise<TextSource[]> {
  const fail = (message: string, description?: string) =>
    new NodeOperationError(ctx.getNode(), message, { itemIndex, ...(description ? { description } : {}) });
  const detected = detectLoader(file.mimeType, file.fileName);
  let kind: Exclude<LoaderKind, 'auto'>;
  if (options.loader === 'auto') {
    if (!detected) throw fail(`Unsupported mime type: ${file.mimeType || 'unknown'}`);
    kind = detected;
  } else {
    if (detected && detected !== options.loader) {
      throw fail(
        `Mime type doesn't match selected loader. Please select under "Loader Type": ${LOADER_LABELS[detected]}`,
      );
    }
    kind = options.loader;
  }

  const limits = ctx.helpers.getInstanceLimits();
  if (file.bytes.byteLength > limits.maxDecompressedBytes) {
    throw fail(`The file is too large: the limit is ${limits.maxDecompressedBytes} bytes`);
  }
  const label = file.fileName ?? 'the file';
  try {
    switch (kind) {
      case 'pdfLoader': {
        const pages = await pdfPages(file.bytes, { maxBytes: limits.maxDecompressedBytes });
        const pdf = { totalPages: pages.length };
        if (options.splitPages === false) return [{ text: pages.join('\n\n'), metadata: { pdf } }];
        return pages.map((text, i) => ({ text, metadata: { pdf, loc: { pageNumber: i + 1 } } }));
      }
      case 'docxLoader':
      case 'epubLoader': {
        const files = await unzipBounded(file.bytes, {
          maxBytes: limits.maxDecompressedBytes,
          maxEntries: limits.maxArchiveEntries,
        });
        return kind === 'docxLoader' ? docxText(files) : epubSources(files);
      }
      case 'csvLoader':
        return csvSources(decoder.decode(file.bytes), options.separator || ',', options.column);
      case 'jsonLoader':
        return jsonSources(decoder.decode(file.bytes), options.pointers);
      case 'textLoader':
        return [{ text: decoder.decode(file.bytes), metadata: {} }];
    }
  } catch (error) {
    if (error instanceof NodeOperationError) throw error;
    if (error instanceof PdfReadError || error instanceof ArchiveError) throw fail(error.message);
    throw fail(`Could not read "${label}": ${(error as Error).message}`);
  }
}
