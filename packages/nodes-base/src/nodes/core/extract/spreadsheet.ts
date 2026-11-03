/**
 * Extract from File: XLSX, XLS and ODS.
 *
 * STUB from the Phase 2 contract step (C0a). Lane L3 writes the reader (SheetJS) and the option
 * fields; until then the operations fail with a clear error.
 */
import {
  type DataObject,
  type ExecuteContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';

export type SpreadsheetOperation = 'xlsx' | 'xls' | 'ods';

/** spreadsheet-only fields of the Options collection (shown for xlsx, xls, ods) */
export const spreadsheetOptionFields: NodeProperty[] = [];

/** one JSON object per row of the input file of item `itemIndex` */
export async function extractSpreadsheet(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: SpreadsheetOperation,
  _options: DataObject,
): Promise<DataObject[]> {
  throw new NodeOperationError(ctx.getNode(), `Extract from ${operation.toUpperCase()} is not built yet`, {
    itemIndex,
  });
}
