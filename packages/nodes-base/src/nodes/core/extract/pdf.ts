/**
 * Extract from File: PDF.
 *
 * STUB from the Phase 2 contract step (C0a). Lane L3 writes the reader (pdfjs-dist) and the option
 * fields; until then the operation fails with a clear error.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';

/** PDF-only fields of the Options collection (Keep Source is shared, see keep-source.ts) */
export const pdfOptionFields: NodeProperty[] = [];

/** the output item for the PDF of input `item` (index `itemIndex`), Keep Source applied */
export async function extractPdf(
  ctx: ExecuteContext,
  itemIndex: number,
  _options: DataObject,
  _item: Item,
): Promise<Item> {
  throw new NodeOperationError(ctx.getNode(), 'Extract from PDF is not built yet', { itemIndex });
}
