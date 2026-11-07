/**
 * Text out of a file or an item's JSON for the document loaders: CSV, DOCX, EPUB, JSON, PDF and
 * plain text, each bounded by the instance limits. Stub: L21 fills it.
 */
import type { BaseContext, DataObject } from '@workflow/workflow';

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
  /** PDF: one source per page */
  splitPages?: boolean;
}

export interface TextSource {
  text: string;
  metadata: DataObject;
}

/** The texts of a binary file, per the selected (or detected) loader. */
export async function fileToSources(
  _ctx: BaseContext,
  _itemIndex: number,
  _file: { bytes: Uint8Array; mimeType?: string; fileName?: string },
  _options: FileTextOptions,
): Promise<TextSource[]> {
  throw new Error('not implemented (L21)');
}

/** The texts of an item's JSON, one per JSON pointer when pointers are given. */
export function itemJsonToSources(_value: unknown, _pointers?: string[]): TextSource[] {
  throw new Error('not implemented (L21)');
}
