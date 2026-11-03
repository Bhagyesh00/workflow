/** Extract from File (P2-04): XLSX, XLS and ODS through SheetJS, with the size guards. */
import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readZipDirectory } from '../src/utils/zip-directory';
import { runNode } from './harness';

type Format = 'xlsx' | 'xls' | 'ods';
const BOOK_TYPE: Record<Format, XLSX.BookType> = { xlsx: 'xlsx', xls: 'biff8', ods: 'ods' };

/** a workbook built by the library: Sheet1 (typed cells, a gap) and Sheet2 */
function workbook(format: Format): Buffer {
  const wb = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet(
    [
      ['name', 'qty', 'when', 'ok', 'note'],
      ['Ada', 3, new Date(Date.UTC(2024, 2, 5)), true, 'first'],
      ['Bob', 4.5, new Date(Date.UTC(2024, 2, 6)), false, null],
      ['Cy', 7, new Date(Date.UTC(2024, 2, 7)), true, 'third'],
    ],
    { cellDates: true, UTC: true },
  );
  XLSX.utils.book_append_sheet(wb, first, 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['city'], ['Oslo'], ['Rome']]), 'Cities');
  return XLSX.write(wb, { type: 'buffer', bookType: BOOK_TYPE[format], cellDates: true }) as Buffer;
}

const fileItem = (data: Uint8Array | string): Item[] => [
  {
    json: { keep: 1 },
    binary: {
      data: {
        data: Buffer.from(typeof data === 'string' ? Buffer.from(data) : data).toString('base64'),
        mimeType: 'application/octet-stream',
      },
    },
  },
];

const run = (
  operation: string,
  data: Uint8Array | string,
  options: DataObject = {},
  nodeLimits?: Record<string, number>,
) =>
  runNode(
    'core.extractFromFile',
    { operation, options },
    fileItem(data),
    nodeLimits ? { services: { nodeLimits } } : {},
  );

const FIRST_ROWS = [
  { name: 'Ada', qty: 3, when: '2024-03-05T00:00:00.000Z', ok: true, note: 'first' },
  { name: 'Bob', qty: 4.5, when: '2024-03-06T00:00:00.000Z', ok: false },
  { name: 'Cy', qty: 7, when: '2024-03-07T00:00:00.000Z', ok: true, note: 'third' },
];

describe('rows per format', () => {
  for (const format of ['xlsx', 'xls', 'ods'] as const) {
    it(`${format}: first sheet, typed values, dates as ISO strings`, async () => {
      const r = await run(format, workbook(format));
      expect(r.status).toBe('success');
      expect(r.outputs[0]).toEqual(FIRST_ROWS);
      expect(r.items[0][0].pairedItem).toEqual({ item: 0 });
    });
  }

  it('sheetName picks a sheet; an unknown sheet is a clear error', async () => {
    const r = await run('xlsx', workbook('xlsx'), { sheetName: 'Cities' });
    expect(r.outputs[0]).toEqual([{ city: 'Oslo' }, { city: 'Rome' }]);
    const missing = await run('xlsx', workbook('xlsx'), { sheetName: 'Nope' });
    expect(missing.status).toBe('error');
    expect(String(missing.error?.message ?? missing.error)).toContain('Nope');
  });

  for (const format of ['xls', 'ods'] as const) {
    it(`${format}: sheetName picks the named sheet, not the first one`, async () => {
      const r = await run(format, workbook(format), { sheetName: 'Cities' });
      expect(r.status).toBe('success');
      expect(r.outputs[0]).toEqual([{ city: 'Oslo' }, { city: 'Rome' }]);
    });
  }

  it('sheetName also matches with other letter case', async () => {
    const r = await run('xls', workbook('xls'), { sheetName: 'cities' });
    expect(r.outputs[0]).toEqual([{ city: 'Oslo' }, { city: 'Rome' }]);
  });

  it('range: an A1 range, or a number of lines to skip', async () => {
    const a1 = await run('xlsx', workbook('xlsx'), { range: 'A1:B3' });
    expect(a1.outputs[0]).toEqual([
      { name: 'Ada', qty: 3 },
      { name: 'Bob', qty: 4.5 },
    ]);
    const skip = await run('xlsx', workbook('xlsx'), { range: '2' });
    // two lines skipped: the third line (Bob) becomes the header, Cy is the only data row
    expect(skip.outputs[0]).toHaveLength(1);
    expect((skip.outputs[0][0] as DataObject).Bob).toBe('Cy');
  });

  it('headerRow false gives one {row: [...]} per line', async () => {
    const r = await run('xlsx', workbook('xlsx'), { headerRow: false, sheetName: 'Cities' });
    expect(r.outputs[0]).toEqual([{ row: ['city'] }, { row: ['Oslo'] }, { row: ['Rome'] }]);
  });

  it('headerRow false: empty cells are null, blank rows stay; includeEmptyCells fills them with ""', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', null, 'c'], [], ['d', 'e', 'f']]), 'S');
    const book = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const holes = await run('xlsx', book, { headerRow: false });
    expect(holes.outputs[0]).toEqual([{ row: ['a', null, 'c'] }, { row: [] }, { row: ['d', 'e', 'f'] }]);
    const filled = await run('xlsx', book, { headerRow: false, includeEmptyCells: true });
    expect(filled.outputs[0][0]).toEqual({ row: ['a', '', 'c'] });
    expect(filled.outputs[0]).toHaveLength(3);
  });

  it('empty cells are left out unless includeEmptyCells is true', async () => {
    const left = await run('xlsx', workbook('xlsx'));
    expect('note' in (left.outputs[0][1] as DataObject)).toBe(false);
    const filled = await run('xlsx', workbook('xlsx'), { includeEmptyCells: true });
    expect((filled.outputs[0][1] as DataObject).note).toBe('');
  });

  it('maxRowCount limits the data rows (-1 reads all)', async () => {
    const two = await run('xlsx', workbook('xlsx'), { maxRowCount: 2 });
    expect(two.outputs[0]).toHaveLength(2);
    const all = await run('xlsx', workbook('xlsx'), { maxRowCount: -1 });
    expect(all.outputs[0]).toHaveLength(3);
  });

  it('rawData keeps dates as the stored serial number', async () => {
    const r = await run('xlsx', workbook('xlsx'), { rawData: true });
    expect((r.outputs[0][0] as DataObject).when).toBe(45356);
  });

  it('readAsString reads a text file (CSV) saved under the xls operation', async () => {
    const r = await run('xls', 'a,b\n1,2\n3,4\n', { readAsString: true });
    expect(r.outputs[0]).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it('rawData with text input keeps the values as text', async () => {
    const r = await run('xls', 'a,b\n1,2\n', { readAsString: true, rawData: true });
    expect(r.outputs[0]).toEqual([{ a: '1', b: '2' }]);
  });

  it('keeps __proto__ out of the row prototype', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['__proto__', 'x'],
        ['p', 1],
      ]),
      'S',
    );
    const r = await run('xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const row = r.outputs[0][0] as DataObject;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row.x).toBe(1);
  });
});

describe('wrong input', () => {
  it('xlsx and ods refuse a file that is not a zip; xls refuses a non-OLE file', async () => {
    for (const op of ['xlsx', 'ods']) {
      const r = await run(op, 'plain text, not a zip file at all');
      expect(r.status).toBe('error');
    }
    const xls = await run('xls', 'plain text, not a workbook');
    expect(xls.status).toBe('error');
  });
});

describe('size guards', () => {
  it('refuses input above maxDecompressedBytes before parsing', async () => {
    const book = workbook('xlsx');
    const r = await run('xlsx', book, {}, { maxDecompressedBytes: book.length - 1 });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toMatch(/too large|limit/i);
  });

  it('refuses a zip whose declared sizes add up above maxDecompressedBytes', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ['x'.repeat(40), i]);
    const bigWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(bigWb, XLSX.utils.aoa_to_sheet([['t', 'n'], ...rows]), 'S');
    const book = XLSX.write(bigWb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    const declared = readZipDirectory(book, { maxEntries: 1000 }).reduce((n, e) => n + e.declaredSize, 0);
    expect(declared).toBeGreaterThan(book.length);
    const r = await run('xlsx', book, {}, { maxDecompressedBytes: declared - 1 });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toMatch(/unpack|limit/i);
    const ok = await run('xlsx', book, {}, { maxDecompressedBytes: declared });
    expect(ok.status).toBe('success');
  });

  it('bounds the rows parsed: a sheet past the cell cap is refused even with maxRowCount unset', async () => {
    const wb = XLSX.utils.book_new();
    const rows = Array.from({ length: 40 }, (_, i) => [i]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[], [], ['n'], ...rows]), 'S');
    for (const format of ['xlsx', 'xls', 'ods'] as const) {
      const book = XLSX.write(wb, { type: 'buffer', bookType: BOOK_TYPE[format] }) as Buffer;
      const over = await run(format, book, {}, { maxSpreadsheetCells: 30 });
      expect(over.status, format).toBe('error');
      expect(String(over.error?.message)).toMatch(/spans 4[13] cells/);
      // maxRowCount reads only the rows it needs, so the cap holds for those rows
      const few = await run(format, book, { range: 2, maxRowCount: 5 }, { maxSpreadsheetCells: 30 });
      expect(few.status, format).toBe('success');
      expect(few.outputs[0]).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    }
  });

  it('refuses a sheet range above maxSpreadsheetCells', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['a'], [1]]);
    ws['!ref'] = 'A1:Z100000';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'S');
    const big = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const r = await run('xlsx', big, {}, { maxSpreadsheetCells: 1000 });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toMatch(/cells/i);
    const small = await run('xlsx', workbook('xlsx'), {}, { maxSpreadsheetCells: 10 });
    expect(small.status).toBe('error');
    const fits = await run('xlsx', workbook('xlsx'), {}, { maxSpreadsheetCells: 20 });
    expect(fits.status).toBe('success');
  });
});
