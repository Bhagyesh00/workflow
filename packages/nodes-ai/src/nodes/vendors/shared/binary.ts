/**
 * Files in and out of vendor nodes: input binary fields and URLs to bytes (size capped by the instance
 * limits), bytes to an output item. L1 fills these; the signatures are final.
 */
import type { DataObject, ExecuteContext, Item } from '@workflow/workflow';

export interface VendorFile {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
}

/** The binary fields named in `fields` (comma separated; empty means `data`) of the item. */
export async function readBinaryFields(
  _ctx: ExecuteContext,
  _itemIndex: number,
  _fields: string,
): Promise<VendorFile[]> {
  throw new Error('not implemented (L1)');
}

/** One input file, from a URL (guarded, no credential) or a binary field; over `maxBytes` fails. */
export async function readInputFile(
  _ctx: ExecuteContext,
  _itemIndex: number,
  _input: { inputType: 'url' | 'binary'; url?: string; binaryField?: string },
  _options?: { maxBytes?: number },
): Promise<VendorFile> {
  throw new Error('not implemented (L1)');
}

/** An output item holding `file` in the binary field `field`, with `json` and the paired item. */
export async function fileToItem(
  _ctx: ExecuteContext,
  _itemIndex: number,
  _file: VendorFile,
  _field: string,
  _json?: DataObject,
): Promise<Item> {
  throw new Error('not implemented (L1)');
}
