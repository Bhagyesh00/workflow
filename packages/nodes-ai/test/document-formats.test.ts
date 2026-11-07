/** Default Data Loader formats (P5-52): PDF, DOCX, EPUB, JSON pointers, CSV column and separator. */
import { zipFiles } from '@workflow/nodes-base/utils/archive';
import type { AiDocument, BaseContext, DataObject, Item } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearMemoryVectorStores } from '../src/nodes/vector-stores/vector-stores.nodes';
import { fileToSources, itemJsonToSources } from '../src/shared/file-text';
import { connect, node, run } from './harness';

const enc = (s: string) => new TextEncoder().encode(s);

/** a context with only what file-text reads */
function fakeCtx(limits: Partial<{ maxDecompressedBytes: number; maxArchiveEntries: number }> = {}) {
  return {
    getNode: () => ({ name: 'Loader', type: 'ai.documentDefaultDataLoader' }),
    helpers: {
      getInstanceLimits: () => ({ maxDecompressedBytes: 10_000_000, maxArchiveEntries: 1000, ...limits }),
    },
  } as unknown as BaseContext;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** an unencrypted PDF, one page per entry, each page a list of text lines */
function makePdf(pages: string[][]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const fontNumber = 3 + pages.length * 2;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  for (const [i, lines] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    const content = `BT /F1 12 Tf 14 TL 72 700 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return enc(out);
}

async function makeDocx(paragraphs: string[], documentXml?: string): Promise<Uint8Array> {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  return zipFiles([
    { name: '[Content_Types].xml', data: enc('<Types/>') },
    {
      name: 'word/document.xml',
      data: enc(
        documentXml ??
          `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`,
      ),
    },
  ]);
}

async function makeEpub(
  chapters: Array<{ file: string; html: string }>,
  spineOrder?: number[],
): Promise<Uint8Array> {
  const manifest = chapters
    .map((c, i) => `<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`)
    .join('');
  const order = spineOrder ?? chapters.map((_, i) => i);
  const spine = order.map((i) => `<itemref idref="c${i}"/>`).join('');
  return zipFiles([
    { name: 'mimetype', data: enc('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: enc(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    },
    {
      name: 'OEBPS/content.opf',
      data: enc(`<package><manifest>${manifest}</manifest><spine>${spine}</spine></package>`),
    },
    ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, data: enc(c.html) })),
  ]);
}

describe('fileToSources', () => {
  it('reads each page of a PDF as a source', async () => {
    const pdf = makePdf([['First page line'], ['Second page line']]);
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: pdf, mimeType: 'application/pdf' },
      { loader: 'auto' },
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]!.text).toBe('First page line');
    expect(sources[1]!.text).toBe('Second page line');
    expect(sources[1]!.metadata).toEqual({ pdf: { totalPages: 2 }, loc: { pageNumber: 2 } });
  });

  it('joins a PDF into one source when Split Pages is off', async () => {
    const pdf = makePdf([['One'], ['Two']]);
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: pdf, mimeType: 'application/pdf' },
      { loader: 'pdfLoader', splitPages: false },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]!.text).toBe('One\n\nTwo');
    expect(sources[0]!.metadata).toEqual({ pdf: { totalPages: 2 } });
  });

  it('says so when a file is not a PDF', async () => {
    await expect(
      fileToSources(fakeCtx(), 0, { bytes: enc('plain'), mimeType: 'application/pdf' }, { loader: 'auto' }),
    ).rejects.toThrow('The file is not a valid PDF');
  });

  it('reads paragraphs of a DOCX', async () => {
    const docx = await makeDocx(['Hello &amp; welcome', 'Second paragraph']);
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: docx, mimeType: DOCX_MIME },
      { loader: 'auto' },
    );
    expect(sources).toEqual([{ text: 'Hello & welcome\nSecond paragraph', metadata: {} }]);
  });

  it('refuses a DOCX without word/document.xml', async () => {
    const zip = await zipFiles([{ name: 'other.xml', data: enc('<a/>') }]);
    await expect(
      fileToSources(fakeCtx(), 0, { bytes: zip, mimeType: DOCX_MIME }, { loader: 'docxLoader' }),
    ).rejects.toThrow('word/document.xml');
  });

  it('refuses a zip bomb over the instance limit', async () => {
    const big = await makeDocx(
      [],
      `<w:document xmlns:w="urn:w"><w:body>${'<w:p/>'.repeat(200_000)}</w:body></w:document>`,
    );
    expect(big.byteLength).toBeLessThan(100_000);
    await expect(
      fileToSources(
        fakeCtx({ maxDecompressedBytes: 100_000 }),
        0,
        { bytes: big, mimeType: DOCX_MIME },
        { loader: 'auto' },
      ),
    ).rejects.toThrow(/size limit/);
  });

  it('keeps an XML entity bomb as text', async () => {
    const lol =
      '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
    const docx = await makeDocx(
      [],
      `${lol}<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>x&c;y</w:t></w:r></w:p></w:body></w:document>`,
    );
    const [source] = await fileToSources(
      fakeCtx(),
      0,
      { bytes: docx, mimeType: DOCX_MIME },
      { loader: 'auto' },
    );
    expect(source!.text).toBe('x&c;y');
  });

  it('reads an EPUB chapter by chapter in spine order', async () => {
    const epub = await makeEpub(
      [
        {
          file: 'one.xhtml',
          html: '<html><head><title>T</title><style>p{}</style></head><body><h1>One</h1><p>First &amp; best</p></body></html>',
        },
        { file: 'two.xhtml', html: '<html><body><p>Second<script>evil()</script></p></body></html>' },
      ],
      [1, 0],
    );
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: epub, mimeType: 'application/epub+zip' },
      { loader: 'auto' },
    );
    expect(sources.map((s) => s.text)).toEqual(['Second', 'One\nFirst & best']);
    expect(sources.map((s) => s.metadata)).toEqual([{ chapter: 1 }, { chapter: 2 }]);
  });

  it('does not resolve an EPUB href outside the archive', async () => {
    const epub = await zipFiles([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
      },
      {
        name: 'content.opf',
        data: enc(
          '<package><manifest><item id="a" href="../../etc/passwd" media-type="application/xhtml+xml"/><item id="b" href="http://evil.test/x.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
        ),
      },
    ]);
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: epub, mimeType: 'application/epub+zip' },
      { loader: 'auto' },
    );
    expect(sources).toEqual([]);
  });

  it('reads JSON by pointers', async () => {
    const json = enc(JSON.stringify({ a: { b: 'deep text' }, list: [{ t: 'x' }, { t: 'y' }], skip: 'no' }));
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: json, mimeType: 'application/json' },
      { loader: 'jsonLoader', pointers: ['/a/b', '/list/1', '/missing', '/__proto__'] },
    );
    expect(sources).toEqual([
      { text: 'deep text', metadata: { pointer: '/a/b' } },
      { text: 't: y', metadata: { pointer: '/list/1' } },
    ]);
  });

  it('reads one CSV column with a separator', async () => {
    const csv = enc('name;role\nAda;math\nAlan;code\n');
    const sources = await fileToSources(
      fakeCtx(),
      0,
      { bytes: csv, mimeType: 'text/csv' },
      { loader: 'csvLoader', separator: ';', column: 'role' },
    );
    expect(sources).toEqual([
      { text: 'math', metadata: { line: 2 } },
      { text: 'code', metadata: { line: 3 } },
    ]);
    await expect(
      fileToSources(
        fakeCtx(),
        0,
        { bytes: csv, mimeType: 'text/csv' },
        { loader: 'csvLoader', separator: ';', column: 'nope' },
      ),
    ).rejects.toThrow('Column "nope" is not in the CSV');
  });

  it('says what is wrong with the mime type', async () => {
    await expect(
      fileToSources(fakeCtx(), 0, { bytes: enc('x'), mimeType: 'image/png' }, { loader: 'auto' }),
    ).rejects.toThrow('Unsupported mime type: image/png');
    await expect(
      fileToSources(
        fakeCtx(),
        0,
        { bytes: makePdf([['a']]), mimeType: 'application/pdf' },
        { loader: 'textLoader' },
      ),
    ).rejects.toThrow(`Mime type doesn't match selected loader. Please select under "Loader Type": PDF`);
  });

  it('turns item JSON into sources', () => {
    expect(itemJsonToSources({ a: 1, b: { c: 'x' } })).toEqual([{ text: 'a: 1\nb.c: x', metadata: {} }]);
    expect(itemJsonToSources({ a: { b: 'hi' } }, ['/a/b'])).toEqual([
      { text: 'hi', metadata: { pointer: '/a/b' } },
    ]);
  });
});

describe('Default Data Loader formats in a workflow', () => {
  beforeEach(() => clearMemoryVectorStores());

  async function loadDocs(loaderParams: DataObject, items: Item[]) {
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'insert' }),
        node('Loader', 'ai.documentDefaultDataLoader', loaderParams),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: items },
    );
    return { r, docs: r.output('Store') as unknown as AiDocument[] };
  }
  const bin = (bytes: Uint8Array, mimeType: string, fileName: string) => ({
    data: Buffer.from(bytes).toString('base64'),
    mimeType,
    fileName,
  });

  it('turns a PDF, a DOCX and an EPUB into documents', async () => {
    const { r, docs } = await loadDocs({ dataType: 'binary' }, [
      {
        json: {},
        binary: {
          pdf: bin(makePdf([['Alpha page'], ['Beta page']]), 'application/pdf', 'a.pdf'),
          docx: bin(await makeDocx(['Gamma words']), DOCX_MIME, 'b.docx'),
          epub: bin(
            await makeEpub([{ file: 'c.xhtml', html: '<html><body><p>Delta chapter</p></body></html>' }]),
            'application/epub+zip',
            'c.epub',
          ),
        },
      },
    ]);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(docs.map((d) => d.pageContent)).toEqual([
      'Alpha page',
      'Beta page',
      'Gamma words',
      'Delta chapter',
    ]);
    expect(docs[1]!.metadata).toEqual({
      source: 'blob',
      blobType: 'application/pdf',
      fileName: 'a.pdf',
      pdf: { totalPages: 2 },
      loc: { pageNumber: 2 },
    });
  });

  it('applies Split Pages, JSON Pointers, CSV Separator and CSV Column', async () => {
    const pdf = await loadDocs({ dataType: 'binary', options: { splitPages: false } }, [
      { json: {}, binary: { data: bin(makePdf([['One'], ['Two']]), 'application/pdf', 'a.pdf') } },
    ]);
    expect(pdf.docs.map((d) => d.pageContent)).toEqual(['One\n\nTwo']);

    const json = await loadDocs({ dataType: 'json', options: { pointers: '/a, /b/c' } }, [
      { json: { a: 'first', b: { c: 'second' }, d: 'unused' } },
    ]);
    expect(json.docs.map((d) => d.pageContent)).toEqual(['first', 'second']);

    const csv = await loadDocs(
      { dataType: 'binary', loader: 'csvLoader', options: { separator: '|', column: 'role' } },
      [{ json: {}, binary: { data: bin(enc('name|role\nAda|math\n'), 'text/csv', 'p.csv') } }],
    );
    expect(csv.docs.map((d) => d.pageContent)).toEqual(['math']);
  });
});
