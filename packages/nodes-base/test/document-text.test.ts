/** P5-74 (L11): `documentText` reads PDF, XLSX, DOCX, HTML, text and markdown within the instance limits. */
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { zipFiles } from '../src/utils/archive';
import { DocumentTextError, documentText } from '../src/utils/document-text';
import { spreadsheetRows } from '../src/nodes/core/extract/spreadsheet';

const LIMITS = { maxDecompressedBytes: 1024 * 1024, maxArchiveEntries: 50, maxSpreadsheetCells: 10_000 };
const options = { limits: LIMITS };

// a hand-written PDF (local copy of the helper in extract-pdf.test.ts, without encryption)
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** each page is a list of text lines */
function makePdf(pages: string[][]): Buffer {
  const contentOf = (lines: string[]) =>
    `BT /F1 12 Tf 14 TL 72 700 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const contentNumber = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    const data = contentOf(lines);
    objects.push(`<< /Length ${data.length} >>\nstream\n${data}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const parts: Buffer[] = [Buffer.from('%PDF-1.6\n', 'latin1')];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(chunk);
    position += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`;
  parts.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(parts);
}

const enc = (text: string) => new TextEncoder().encode(text);

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
}

async function docx(paragraphs: string[], extra: { name: string; data: Uint8Array }[] = []) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: enc('<Types/>') },
    { name: 'word/document.xml', data: enc(xml) },
    ...extra,
  ]);
}

describe('documentText (P5-74)', () => {
  it('reads the pages of a PDF, joined by blank lines, and cuts at maxPages', async () => {
    const pdf = makePdf([['First page'], ['Second page'], ['Third page']]);
    const all = await documentText(pdf, 'pdf', options);
    expect(all.text).toContain('First page');
    expect(all.text).toContain('Third page');
    expect(all.pages).toBe(3);
    expect(all.truncated).toBe(false);
    expect(all.text.split('\n\n')).toHaveLength(3);

    const cut = await documentText(pdf, 'pdf', { ...options, maxPages: 2 });
    expect(cut.pages).toBe(2);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain('Second page');
    expect(cut.text).not.toContain('Third page');

    const exact = await documentText(pdf, 'pdf', { ...options, maxPages: 3 });
    expect(exact.truncated).toBe(false);
  });

  it('refuses a damaged PDF with a DocumentTextError', async () => {
    await expect(documentText(enc('not a pdf at all'), 'pdf', options)).rejects.toBeInstanceOf(
      DocumentTextError,
    );
  });

  it('reads every sheet of an XLSX as tab separated text', async () => {
    const bytes = workbook({
      People: [
        ['name', 'age'],
        ['Ada', 36],
      ],
      Cities: [['city'], ['Pune']],
    });
    const out = await documentText(bytes, 'xlsx', options);
    expect(out.text).toContain('## Sheet: People\nname\tage\nAda\t36');
    expect(out.text).toContain('## Sheet: Cities\ncity\nPune');
    expect(out.pages).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('refuses an XLSX over the cell limit and a file that is not a workbook', async () => {
    const big = workbook({ Big: [Array.from({ length: 50 }, (_, i) => i), Array.from({ length: 50 }, (_, i) => i)] });
    await expect(
      documentText(big, 'xlsx', { limits: { ...LIMITS, maxSpreadsheetCells: 20 } }),
    ).rejects.toThrow(/cells/);
    await expect(documentText(enc('plain text'), 'xlsx', options)).rejects.toBeInstanceOf(DocumentTextError);
  });

  it('spreadsheetRows is the node reader without the node', () => {
    const rows = spreadsheetRows(
      workbook({ S: [['a', 'b'], [1, 2]] }),
      'xlsx',
      {},
      LIMITS,
    );
    expect(rows).toEqual([{ a: 1, b: 2 }]);
  });

  it('reads the paragraphs of a DOCX, with entities decoded', async () => {
    const out = await documentText(await docx(['Hello &amp; welcome', 'Second paragraph']), 'docx', options);
    expect(out.text).toBe('Hello & welcome\n\nSecond paragraph');
  });

  it('refuses a DOCX that has no document part and a zip bomb', async () => {
    const empty = await zipFiles([{ name: 'other.xml', data: enc('<a/>') }]);
    await expect(documentText(empty, 'docx', options)).rejects.toThrow(/document\.xml/);

    const bomb = await docx(['x'], [{ name: 'word/padding.bin', data: new Uint8Array(4 * 1024 * 1024) }]);
    expect(bomb.byteLength).toBeLessThan(100_000);
    await expect(documentText(bomb, 'docx', options)).rejects.toBeInstanceOf(DocumentTextError);
    await expect(documentText(bomb, 'docx', options)).rejects.toThrow(/limit|larger|unpack|more than/i);
  });

  it('refuses a DOCX with more entries than allowed', async () => {
    const many = await docx(
      ['x'],
      Array.from({ length: 10 }, (_, i) => ({ name: `word/f${i}.xml`, data: enc('<a/>') })),
    );
    await expect(
      documentText(many, 'docx', { limits: { ...LIMITS, maxArchiveEntries: 5 } }),
    ).rejects.toBeInstanceOf(DocumentTextError);
  });

  it('strips an HTML page to its visible text', async () => {
    const html =
      '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p><!-- note --><ul><li>a</li><li>b</li></ul></body></html>';
    const out = await documentText(enc(html), 'html', options);
    expect(out.text).toBe('Title\nOne & two\na\nb');
    expect(out.text).not.toContain('alert');
  });

  it('keeps text and markdown as they are (BOM dropped) and cuts at maxChars', async () => {
    const out = await documentText(enc('﻿# Heading\n\nbody'), 'markdown', options);
    expect(out.text).toBe('# Heading\n\nbody');
    const cut = await documentText(enc('0123456789'), 'text', { ...options, maxChars: 4 });
    expect(cut).toEqual({ text: '0123', truncated: true });
  });

  it('refuses bytes that are not a zip as a DOCX', async () => {
    await expect(documentText(enc('PK'), 'docx', options)).rejects.toBeInstanceOf(DocumentTextError);
  });
});
