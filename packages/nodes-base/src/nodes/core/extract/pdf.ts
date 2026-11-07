/**
 * Extract from File: PDF text (pdfjs-dist, legacy build, loaded on first use).
 *
 * The document is parsed with font loading from page data switched off (`disableFontFace: true`; pdfjs 6
 * has no eval option left). The password option is passed to the library only and never put into an
 * error message.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';
import { keepSourceMode, keptSource } from './keep-source';

const PDF_SHOW = { '/operation': ['pdf'] };

/** PDF-only fields of the Options collection (Keep Source is shared, see keep-source.ts) */
export const pdfOptionFields: NodeProperty[] = [
  {
    displayName: 'Join Pages',
    name: 'joinPages',
    type: 'boolean',
    default: true,
    description:
      'Whether to join the text of all pages into one string; off gives a list with one string per page',
    displayOptions: { show: PDF_SHOW },
  },
  {
    displayName: 'Max Pages',
    name: 'maxPages',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0 },
    description: 'Number of pages to read from the start; 0 reads every page',
    displayOptions: { show: PDF_SHOW },
  },
  {
    displayName: 'Password',
    name: 'password',
    type: 'string',
    default: '',
    typeOptions: { password: true },
    description: 'Password of an encrypted PDF',
    displayOptions: { show: PDF_SHOW },
  },
];

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjs: Promise<PdfJs> | undefined;
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/** the folder of the library's standard fonts, with a trailing slash; undefined if it is not found */
function standardFontsDirectory(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
    return `${path.join(path.dirname(entry), '..', '..', 'standard_fonts')}${path.sep}`;
  } catch {
    return undefined;
  }
}

/** a PDF that cannot be read; the message is safe to show (it never holds the password) */
export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfReadError';
  }
}

export interface PdfPagesOptions {
  password?: string;
  /** pages to read from the start; 0 or unset reads every page */
  maxPages?: number;
  /** bytes of the file and characters of text allowed; defaults to 64 MiB */
  maxBytes?: number;
}

interface PdfRead {
  pages: string[];
  numpages: number;
  numrender: number;
  info: DataObject;
  metadata: DataObject;
  version: string;
}

async function readPdf(bytes: Uint8Array, options: PdfPagesOptions): Promise<PdfRead> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (bytes.byteLength > maxBytes) {
    throw new PdfReadError(`The file is too large: the limit is ${maxBytes} bytes`);
  }
  const maxPages = Math.max(0, Math.floor(Number(options.maxPages ?? 0)) || 0);
  const password =
    typeof options.password === 'string' && options.password !== '' ? options.password : undefined;

  const lib = await loadPdfJs();
  const fonts = standardFontsDirectory();
  const task = lib.getDocument({
    // the library takes ownership of the array it is given
    data: new Uint8Array(bytes),
    password,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    ...(fonts ? { standardFontDataUrl: pathToFileURL(fonts).href } : {}),
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    // the loading task holds the parser and its message port: release it on a failed open too
    await task.destroy().catch(() => undefined);
    throw new PdfReadError(describeOpenError(error));
  }

  try {
    const numpages = doc.numPages;
    const toRead = maxPages > 0 ? Math.min(maxPages, numpages) : numpages;
    const pages: string[] = [];
    // content streams are deflated, so a small file can hold any amount of text: cap the characters read
    const budget = { left: maxBytes };
    for (let number = 1; number <= toRead; number++) {
      const page = await doc.getPage(number);
      const items = await readTextItems(page, budget);
      if (items === undefined) {
        throw new PdfReadError(`The PDF text is too large: the limit is ${maxBytes} characters`);
      }
      pages.push(pageText(items));
      page.cleanup();
    }
    const meta = await doc.getMetadata();
    return {
      pages,
      numpages,
      numrender: toRead,
      info: toPlain(meta.info) as DataObject,
      metadata: toPlain(
        meta.metadata ? Object.fromEntries(meta.metadata as Iterable<[string, unknown]>) : null,
      ) as DataObject,
      version: lib.version,
    };
  } catch (error) {
    if (error instanceof PdfReadError) throw error;
    throw new PdfReadError(
      'The PDF could not be read: the file is damaged or uses a feature that is not supported',
    );
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** The text of each page of a PDF (one string per page), bounded by `maxBytes`. Throws PdfReadError. */
export async function pdfPages(bytes: Uint8Array, options: PdfPagesOptions = {}): Promise<string[]> {
  return (await readPdf(bytes, options)).pages;
}

/** the output item for the PDF of input `item` (index `itemIndex`), Keep Source applied */
export async function extractPdf(
  ctx: ExecuteContext,
  itemIndex: number,
  options: DataObject,
  item: Item,
): Promise<Item> {
  const limits = ctx.helpers.getInstanceLimits();
  const property = String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data') || 'data');
  const bytes = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
  const joinPages = options.joinPages !== false;
  let read: PdfRead;
  try {
    read = await readPdf(bytes, {
      maxPages: Number(options.maxPages ?? 0),
      password: typeof options.password === 'string' ? options.password : undefined,
      maxBytes: limits.maxDecompressedBytes,
    });
  } catch (error) {
    if (error instanceof PdfReadError)
      throw new NodeOperationError(ctx.getNode(), error.message, { itemIndex });
    throw error;
  }
  const output: DataObject = {
    numpages: read.numpages,
    numrender: read.numrender,
    info: read.info,
    metadata: read.metadata,
    text: joinPages ? read.pages.join('\n\n') : read.pages,
    version: read.version,
  };
  const kept = keptSource(keepSourceMode(options.keepSource), item);
  const result: Item = { json: { ...kept.json, ...output } };
  if (kept.binary) result.binary = kept.binary;
  return result;
}

interface TextPage {
  streamTextContent(): ReadableStream<{ items: ReadonlyArray<unknown> }>;
}

/**
 * The page's text items, read as a stream; undefined once `budget` runs out. The stream is not
 * cancelled (pdfjs then enqueues into a closed controller and rejects unhandled); the caller
 * destroys the loading task, which stops the parser.
 */
async function readTextItems(page: TextPage, budget: { left: number }): Promise<unknown[] | undefined> {
  const reader = page.streamTextContent().getReader();
  const items: unknown[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return items;
    for (const item of value.items) {
      const str = (item as { str?: unknown }).str;
      if (typeof str === 'string') budget.left -= str.length;
      items.push(item);
    }
    if (budget.left < 0) {
      reader.releaseLock();
      return undefined;
    }
  }
}

/** text items to lines: a new line starts when the baseline moves */
function pageText(items: ReadonlyArray<unknown>): string {
  let text = '';
  let lastY: number | undefined;
  for (const raw of items) {
    const entry = raw as { str?: string; transform?: number[] };
    if (typeof entry.str !== 'string') continue;
    const y = entry.transform?.[5];
    if (lastY !== undefined && y !== lastY && text !== '') text += '\n';
    text += entry.str;
    lastY = y;
  }
  return text;
}

function describeOpenError(error: unknown): string {
  const e = error as { name?: string; code?: number; message?: string };
  if (e?.name === 'PasswordException') {
    return e.code === 2
      ? 'The password for this PDF is wrong'
      : 'The PDF is password protected: set the Password option';
  }
  if (e?.name === 'InvalidPDFException') return 'The file is not a valid PDF';
  if (e?.name === 'MissingPDFException') return 'The PDF is empty or missing';
  return 'The PDF could not be opened: the file is damaged or uses a feature that is not supported';
}

/** drop prototypes and unsupported values so the result is plain JSON */
function toPlain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
