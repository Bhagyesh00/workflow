/**
 * The text of a document file (`@workflow/nodes-base/utils/document-text`), for the Assistant's `parse_file`
 * tool (P5-74): PDF through `pdfPages` (extract/pdf.ts), XLSX through the Extract From File sheet reader,
 * DOCX through `unzipBounded` (utils/archive.ts) and its XML, HTML stripped to text, text and markdown as
 * they are. Every container is read within the instance's decompression limits; a file it cannot or may
 * not read throws `DocumentTextError` with a text a person can act on. CSV, TSV and JSON are read by the
 * server itself (rows paged), not here.
 */
import type { InstanceLimits } from '@workflow/workflow';

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

/** The text of `bytes` read as `format`, within `options.limits`. Throws `DocumentTextError`. */
export async function documentText(
  _bytes: Uint8Array,
  _format: DocumentFormat,
  _options: DocumentTextOptions,
): Promise<DocumentText> {
  throw new Error('not implemented (L11)');
}
