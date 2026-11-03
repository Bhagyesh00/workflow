/** Extract from File (P2-04): PDF text through pdfjs-dist (legacy build, lazy loaded). */
import { createCipheriv, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { runNode } from './harness';

// ---------------------------------------------------------------------------------------------
// hand-written PDFs

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

interface PdfOptions {
  title?: string;
  author?: string;
  /** user password: the standard security handler, AESV2 (V4 R4) */
  password?: string;
  /** compress each content stream (FlateDecode) */
  flate?: boolean;
}

/** each page is a list of text lines */
function makePdf(pages: string[][], options: PdfOptions = {}): Buffer {
  const id = Buffer.from('0123456789abcdef');
  const encrypt = options.password !== undefined;
  const fileKey = encrypt ? makeFileKey(options.password!, id) : Buffer.alloc(0);

  const contentOf = (lines: string[]) =>
    `BT /F1 12 Tf 14 TL 72 700 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;

  const objects: Array<string | Buffer> = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontNumber = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const contentNumber = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`,
    );
    let data: Buffer = Buffer.from(contentOf(lines), 'latin1');
    if (options.flate) data = deflateSync(data);
    if (encrypt) data = aesEncrypt(fileKey, contentNumber, data);
    const filter = options.flate ? ' /Filter /FlateDecode' : '';
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${data.length}${filter} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // fontNumber
  const infoNumber = objects.length + 1;
  objects.push(`<< /Title (${esc(options.title ?? '')}) /Author (${esc(options.author ?? '')}) >>`);
  let encryptNumber = 0;
  if (encrypt) {
    encryptNumber = objects.length + 1;
    const o = Buffer.alloc(32, 7);
    const u = makeU(fileKey, id);
    objects.push(
      `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> ` +
        `/StmF /StdCF /StrF /StdCF /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P -4 >>`,
    );
  }

  const parts: Buffer[] = [Buffer.from('%PDF-1.6\n', 'latin1')];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    position += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoNumber} 0 R` +
    (encrypt ? ` /Encrypt ${encryptNumber} 0 R` : '') +
    ` /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${position}\n%%EOF`;
  parts.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(parts);
}

// the standard security handler (PDF 1.7, algorithms 2, 5 and the AESV2 object key)
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const P_BYTES = Buffer.from([0xfc, 0xff, 0xff, 0xff]); // -4 as 32-bit little endian
const md5 = (...b: Buffer[]) => createHash('md5').update(Buffer.concat(b)).digest();

function makeFileKey(password: string, id: Buffer): Buffer {
  const pwd = Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);
  const o = Buffer.alloc(32, 7);
  let key = md5(pwd, o, P_BYTES, id);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  return key.subarray(0, 16);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + s[a]) & 255;
    [s[a], s[b]] = [s[b], s[a]];
    out[n] = data[n] ^ s[(s[a] + s[b]) & 255];
  }
  return out;
}

function makeU(fileKey: Buffer, id: Buffer): Buffer {
  let u = rc4(fileKey, md5(PAD, id));
  for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(fileKey.map((k) => k ^ i)), u);
  return Buffer.concat([u, Buffer.alloc(16, 0)]);
}

function aesEncrypt(fileKey: Buffer, objectNumber: number, data: Buffer): Buffer {
  const objectKey = md5(
    fileKey,
    Buffer.from([objectNumber & 255, (objectNumber >> 8) & 255, (objectNumber >> 16) & 255, 0, 0]),
    Buffer.from('sAlT'),
  ).subarray(0, 16);
  const iv = Buffer.alloc(16, 9);
  const cipher = createCipheriv('aes-128-cbc', objectKey, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

// ---------------------------------------------------------------------------------------------

const pdfItem = (data: Uint8Array): Item[] => [
  {
    json: { keep: 1 },
    binary: { data: { data: Buffer.from(data).toString('base64'), mimeType: 'application/pdf' } },
  },
];
const run = (data: Uint8Array, options: DataObject = {}, nodeLimits?: Record<string, number>) =>
  runNode(
    'core.extractFromFile',
    { operation: 'pdf', options },
    pdfItem(data),
    nodeLimits ? { services: { nodeLimits } } : {},
  );

const TWO_PAGES = makePdf([['Hello PDF', 'second line'], ['Page two']], {
  title: 'Doc title',
  author: 'Ada',
});

describe('PDF text', () => {
  it('reads the text, joined pages by default, with the n8n output fields', async () => {
    const r = await run(TWO_PAGES);
    expect(r.status).toBe('success');
    const json = r.outputs[0][0] as DataObject;
    expect(json.text).toBe('Hello PDF\nsecond line\n\nPage two');
    expect(json.numpages).toBe(2);
    expect(json.numrender).toBe(2);
    expect((json.info as DataObject).Title).toBe('Doc title');
    expect((json.info as DataObject).Author).toBe('Ada');
    expect(json).toHaveProperty('metadata');
    expect(typeof json.version).toBe('string');
    expect(r.items[0][0].pairedItem).toEqual({ item: 0 });
    expect(json.keep).toBeUndefined();
  });

  it('joinPages false gives one string per page', async () => {
    const r = await run(TWO_PAGES, { joinPages: false });
    expect((r.outputs[0][0] as DataObject).text).toEqual(['Hello PDF\nsecond line', 'Page two']);
  });

  it('maxPages stops early: numrender counts the pages read', async () => {
    const r = await run(TWO_PAGES, { maxPages: 1 });
    const json = r.outputs[0][0] as DataObject;
    expect(json.text).toBe('Hello PDF\nsecond line');
    expect(json.numpages).toBe(2);
    expect(json.numrender).toBe(1);
  });

  it.each([
    ['json', { keep: 1 }, false],
    ['binary', {}, true],
    ['both', { keep: 1 }, true],
  ] as const)('keepSource %s', async (keepSource, kept, binary) => {
    const r = await run(TWO_PAGES, { keepSource });
    expect(r.outputs[0][0]).toMatchObject(kept);
    expect(Boolean(r.items[0][0].binary?.data)).toBe(binary);
    if (!('keep' in kept)) expect((r.outputs[0][0] as DataObject).keep).toBeUndefined();
  });

  it('a file that is not a PDF is a clear error', async () => {
    const r = await run(Buffer.from('this is not a pdf'));
    expect(r.status).toBe('error');
  });

  it('refuses input above maxDecompressedBytes', async () => {
    const r = await run(TWO_PAGES, {}, { maxDecompressedBytes: TWO_PAGES.length - 1 });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toMatch(/too large|limit/i);
  });
});

describe('PDF text cap', () => {
  it('refuses a deflated content stream whose text passes maxDecompressedBytes', async () => {
    // 45 lines of 60 characters fit on the page (pdfjs drops text outside the page box)
    const lines = Array.from({ length: 45 }, () => 'A'.repeat(60));
    const bomb = makePdf([lines], { flate: true });
    const limit = bomb.length + 500;
    expect(limit).toBeLessThan(45 * 60);
    const r = await run(bomb, {}, { maxDecompressedBytes: limit });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toMatch(/text is too large/);
    const ok = await run(bomb, {}, { maxDecompressedBytes: 45 * 60 + 1000 });
    expect(ok.status).toBe('success');
    expect(((ok.outputs[0][0] as DataObject).text as string).replace(/\n/g, '')).toHaveLength(45 * 60);
  });
});

describe('PDF password', () => {
  const secret = makePdf([['Secret text']], { password: 'open sesame' });

  it('reads with the right password', async () => {
    const r = await run(secret, { password: 'open sesame' });
    expect(r.status).toBe('success');
    expect((r.outputs[0][0] as DataObject).text).toBe('Secret text');
  });

  it('missing and wrong passwords fail without echoing the password', async () => {
    const none = await run(secret);
    expect(none.status).toBe('error');
    const wrong = await run(secret, { password: 'guess-1234' });
    expect(wrong.status).toBe('error');
    expect(JSON.stringify(wrong.error)).not.toContain('guess-1234');
  });
});
