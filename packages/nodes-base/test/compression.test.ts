/**
 * P2-03 Compression node: zip, gzip, tar and tar.gz both ways, bounded by the instance limits.
 * Interop fixtures in test/fixtures/compression were made once with Python zipfile and Git Bash tar/gzip.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import type { BinaryData, DataObject, Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { readZipDirectory } from '../src/utils/zip-directory';
import { runNode } from './harness';

const MB = 1024 * 1024;
const FIXTURES = join(__dirname, 'fixtures', 'compression');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const text = (s: string) => new TextEncoder().encode(s);

function bin(data: Uint8Array, fileName?: string, mimeType = 'application/octet-stream'): BinaryData {
  return { data: Buffer.from(data).toString('base64'), mimeType, fileName, fileSize: data.byteLength };
}
const bytesOf = (b: BinaryData | undefined) => Buffer.from(b?.data ?? '', 'base64');

function input(binary: Record<string, BinaryData>, json: DataObject = { keep: 1 }): Item[] {
  return [{ json, binary }];
}

const compress = (params: DataObject, items: Item[], services = {}) =>
  runNode('core.compression', { operation: 'compress', ...params }, items, { services });
const decompress = (params: DataObject, items: Item[], services = {}) =>
  runNode('core.compression', { operation: 'decompress', ...params }, items, { services });
const limits = (l: { maxDecompressedBytes?: number; maxArchiveEntries?: number }) => ({ nodeLimits: l });

/** a hand-built zip, so tests control flags, methods and the sizes the central directory declares */
interface RawEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  declaredSize?: number;
  crc?: number;
}
function makeZip(entries: RawEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 0;
    const payload = method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data);
    const name = Buffer.from(e.name, 'utf8');
    const flags = e.flags ?? 0x0800;
    const crc = e.crc ?? crc32(e.data);
    const size = e.declaredSize ?? e.data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** a minimal ustar archive with the given names (used for hostile names and entry counts) */
function makeTar(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${e.data.byteLength.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, Buffer.from(e.data), Buffer.alloc((512 - (e.data.byteLength % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const binaries = (item: Item | undefined) => item?.binary ?? {};

describe('Compression node description', () => {
  it('offers both operations and the four output formats', async () => {
    const { nodes } = await import('../src');
    const type = nodes.find((n) => n.description.name === 'core.compression');
    const props = type?.description.properties ?? [];
    const operation = props.find((p) => p.name === 'operation');
    expect(operation?.default).toBe('decompress');
    expect(operation?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'compress',
      'decompress',
    ]);
    const format = props.find((p) => p.name === 'outputFormat');
    expect(format?.default).toBe('zip');
    expect(format?.options?.map((o) => (o as { value: string }).value)).toEqual([
      'gzip',
      'tar',
      'targz',
      'zip',
    ]);
  });
});

describe('round trips', () => {
  const report = text('Report line\n'.repeat(200));
  const noise = randomBytes(5000);

  it('zip: two fields into one archive and back', async () => {
    const zipped = await compress(
      { binaryPropertyName: 'data, other', outputFormat: 'zip', fileName: 'bundle.zip' },
      input({ data: bin(report, 'report.txt', 'text/plain'), other: bin(noise, 'noise.bin') }),
    );
    expect(zipped.status).toBe('success');
    const out = zipped.items[0][0];
    expect(out.json).toEqual({ keep: 1 });
    expect(out.pairedItem).toEqual({ item: 0 });
    expect(Object.keys(binaries(out))).toEqual(['data']);
    expect(out.binary?.data).toMatchObject({ fileName: 'bundle.zip', mimeType: 'application/zip' });

    const unzipped = await decompress({ binaryPropertyName: 'data' }, [out]);
    expect(unzipped.status).toBe('success');
    const files = binaries(unzipped.items[0][0]);
    expect(Object.keys(files)).toEqual(['file_0', 'file_1']);
    expect(files.file_0).toMatchObject({
      fileName: 'report.txt',
      mimeType: 'text/plain',
      fileSize: report.length,
    });
    expect(bytesOf(files.file_0).equals(Buffer.from(report))).toBe(true);
    expect(files.file_1).toMatchObject({ fileName: 'noise.bin', fileSize: noise.length });
    expect(bytesOf(files.file_1).equals(noise)).toBe(true);
    expect(unzipped.items[0][0].json).toEqual({ keep: 1 });
  });

  it('zip: stores already-compressed files and deflates the rest', async () => {
    const zipped = await compress(
      { binaryPropertyName: 'a,b', outputFormat: 'zip', fileName: 'mixed.zip' },
      input({ a: bin(report, 'report.txt'), b: bin(noise, 'photo.png', 'image/png') }),
    );
    const entries = readZipDirectory(bytesOf(zipped.items[0][0].binary?.data), { maxEntries: 10 });
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ['report.txt', 8],
      ['photo.png', 0],
    ]);
    expect(entries[0].compressedSize).toBeLessThan(report.length);
  });

  it('gzip: one key per file, named <name>.gz, and back', async () => {
    const zipped = await compress(
      { binaryPropertyName: 'data,other', outputFormat: 'gzip', binaryPropertyOutput: 'out' },
      input({ data: bin(report, 'report.txt', 'text/plain'), other: bin(noise, 'noise.bin') }),
    );
    expect(zipped.status).toBe('success');
    const files = binaries(zipped.items[0][0]);
    expect(Object.keys(files)).toEqual(['out', 'out1']);
    expect(files.out).toMatchObject({ fileName: 'report.txt.gz', mimeType: 'application/gzip' });
    expect(files.out1?.fileName).toBe('noise.bin.gz');

    const back = await decompress({ binaryPropertyName: 'out,out1', outputPrefix: 'x_' }, zipped.items[0]);
    const unpacked = binaries(back.items[0][0]);
    expect(Object.keys(unpacked)).toEqual(['x_0', 'x_1']);
    expect(unpacked.x_0).toMatchObject({ fileName: 'report.txt', mimeType: 'text/plain' });
    expect(bytesOf(unpacked.x_0).equals(Buffer.from(report))).toBe(true);
    expect(bytesOf(unpacked.x_1).equals(noise)).toBe(true);
  });

  it('gzip: a file name option replaces the name and keeps one .gz', async () => {
    const zipped = await compress(
      { binaryPropertyName: 'data', outputFormat: 'gzip', fileName: 'renamed.gz' },
      input({ data: bin(report, 'report.txt') }),
    );
    expect(zipped.items[0][0].binary?.data?.fileName).toBe('renamed.gz');
  });

  it.each([
    ['tar', 'bundle.tar', 'application/x-tar'],
    ['targz', 'bundle.tar.gz', 'application/gzip'],
  ])('%s: files with long names and back', async (outputFormat, fileName, mimeType) => {
    const longName = `${'deep-directory/'.repeat(9)}${'a-file-name-'.repeat(12)}.txt`;
    const veryLongName = 'x'.repeat(300);
    const splitName = `${'p'.repeat(120)}/file.txt`;
    expect(longName.length).toBeGreaterThan(100);
    const zipped = await compress(
      { binaryPropertyName: 'a,b,c,d', outputFormat, fileName },
      input({
        a: bin(report, 'report.txt'),
        b: bin(noise, longName),
        c: bin(text('v'), veryLongName),
        d: bin(text('p'), splitName),
      }),
    );
    expect(zipped.status).toBe('success');
    expect(zipped.items[0][0].binary?.data).toMatchObject({ fileName, mimeType });
    const back = await decompress({ binaryPropertyName: 'data' }, zipped.items[0]);
    expect(back.status).toBe('success');
    const files = binaries(back.items[0][0]);
    expect(Object.keys(files)).toEqual(['file_0', 'file_1', 'file_2', 'file_3']);
    expect(bytesOf(files.file_0).equals(Buffer.from(report))).toBe(true);
    expect(bytesOf(files.file_1).equals(noise)).toBe(true);
    expect(files.file_1?.fileName).toBe(`${'a-file-name-'.repeat(12)}.txt`);
    expect(files.file_1?.directory).toBe('deep-directory/'.repeat(9).slice(0, -1));
    expect(files.file_2?.fileName).toBe(veryLongName);
    expect(files.file_3).toMatchObject({ fileName: 'file.txt', directory: 'p'.repeat(120) });
  });

  it('several input items each give their own archive', async () => {
    const r = await compress({ outputFormat: 'zip', fileName: 'one.zip' }, [
      { json: { n: 1 }, binary: { data: bin(text('first'), 'a.txt') } },
      { json: { n: 2 }, binary: { data: bin(text('second'), 'b.txt') } },
    ]);
    expect(r.outputs[0]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });
});

describe('archives made by other tools', () => {
  it('reads a Python zipfile archive: stored, deflated, directory and __MACOSX entries', async () => {
    const r = await decompress(
      {},
      input({ data: bin(fixture('python.zip'), 'python.zip', 'application/zip') }),
    );
    expect(r.status).toBe('success');
    const files = binaries(r.items[0][0]);
    expect(Object.keys(files)).toEqual(['file_0', 'file_1']);
    expect(files.file_0).toMatchObject({ fileName: 'stored.txt', mimeType: 'text/plain' });
    expect(bytesOf(files.file_0).toString()).toBe('Stored by Python zipfile\n');
    expect(files.file_1).toMatchObject({ fileName: 'deflated.txt', directory: 'docs' });
    expect(bytesOf(files.file_1).toString()).toBe('Deflated by Python zipfile. '.repeat(20));
  });

  it.each(['gnu.tar', 'pax.tar'])('reads a Git Bash tar archive with a long name (%s)', async (name) => {
    const r = await decompress({}, input({ data: bin(fixture(name), name) }));
    expect(r.status).toBe('success');
    const files = binaries(r.items[0][0]);
    expect(Object.values(files).map((f) => [f.directory, f.fileName])).toEqual([
      [undefined, 'hello.txt'],
      ['docs', 'readme.md'],
      [
        'very-long-directory-name-for-testing-the-gnu-long-name-header-in-tar-archives-made-by-git-bash/sub',
        'deep-file-with-a-long-name.txt',
      ],
    ]);
    expect(bytesOf(files.file_0).toString()).toBe('Hello from the tar fixture\n');
    expect(bytesOf(files.file_1).toString()).toBe('# Readme\nline two\n');
    expect(bytesOf(files.file_2).toString()).toBe('deep file\n');
  });

  it('reads a Git Bash tar.gz archive', async () => {
    const r = await decompress({}, input({ data: bin(fixture('data.tar.gz'), 'data.tar.gz') }));
    expect(r.status).toBe('success');
    const files = binaries(r.items[0][0]);
    expect(Object.values(files).map((f) => f.fileName)).toEqual(['hello.txt', 'readme.md']);
  });

  it('reads a Git Bash gzip file', async () => {
    const r = await decompress({}, input({ data: bin(fixture('hello.txt.gz'), 'hello.txt.gz') }));
    expect(r.status).toBe('success');
    const file = binaries(r.items[0][0]).file_0;
    expect(file).toMatchObject({ fileName: 'hello.txt', mimeType: 'text/plain' });
    expect(bytesOf(file).toString()).toBe('Hello from the tar fixture\n');
  });

  it('takes the format from the file extension when the name has none', async () => {
    const gz = gzipSync(text('by extension'));
    const r = await decompress({}, input({ data: { ...bin(gz), fileExtension: 'gz' } }));
    expect(r.status).toBe('success');
    expect(bytesOf(binaries(r.items[0][0]).file_0).toString()).toBe('by extension');
  });
});

describe('size limits', () => {
  const zeros = Buffer.alloc(50 * MB);
  const oneMb = limits({ maxDecompressedBytes: MB });

  async function expectLimit(file: BinaryData, services = oneMb) {
    const started = Date.now();
    const r = await decompress({}, input({ data: file }), services);
    const elapsed = Date.now() - started;
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('size limit of 1 MB');
    expect(elapsed).toBeLessThan(1000);
  }

  it('a zip of 50 MB of zeros stops at a 1 MB limit', async () => {
    const zip = makeZip([{ name: 'zeros.bin', data: zeros, method: 8 }]);
    expect(zip.byteLength).toBeLessThan(100_000);
    await expectLimit(bin(zip, 'bomb.zip'));
  });

  it('a zip that declares 10 bytes but inflates to 50 MB still stops at the limit', async () => {
    const zip = makeZip([{ name: 'zeros.bin', data: zeros, method: 8, declaredSize: 10 }]);
    expect(readZipDirectory(zip, { maxEntries: 5 })[0].declaredSize).toBe(10);
    await expectLimit(bin(zip, 'liar.zip'));
  });

  it('the limit is the total over all entries of one archive', async () => {
    const part = Buffer.alloc(600 * 1024);
    const zip = makeZip([
      { name: 'a.bin', data: part, method: 8 },
      { name: 'b.bin', data: part, method: 8 },
    ]);
    await expectLimit(bin(zip, 'two.zip'));
  });

  it('a stored entry above the limit is refused', async () => {
    const zip = makeZip([{ name: 'big.bin', data: Buffer.alloc(MB + 1) }]);
    await expectLimit(bin(zip, 'stored.zip'));
  });

  it('a gzip of 50 MB of zeros stops at the limit', async () => {
    await expectLimit(bin(gzipSync(zeros), 'zeros.bin.gz'));
  });

  it('a tar.gz of 50 MB of zeros stops at the limit', async () => {
    const tar = makeTar([{ name: 'zeros.bin', data: zeros }]);
    await expectLimit(bin(gzipSync(tar), 'zeros.tar.gz'));
    await expectLimit(bin(gzipSync(tar), 'zeros.tgz'));
  });

  it('a plain tar above the limit is refused', async () => {
    await expectLimit(bin(makeTar([{ name: 'big.bin', data: Buffer.alloc(MB + 1) }]), 'big.tar'));
  });

  it('a file at the limit passes', async () => {
    const zip = makeZip([{ name: 'exact.bin', data: Buffer.alloc(MB), method: 8 }]);
    const r = await decompress({}, input({ data: bin(zip, 'exact.zip') }), oneMb);
    expect(r.status).toBe('success');
    expect(binaries(r.items[0][0]).file_0?.fileSize).toBe(MB);
  });

  it('a zip with 1001 entries is refused at the default limit of 1000', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.txt`, data: new Uint8Array() }));
    const r = await decompress({}, input({ data: bin(makeZip(many), 'many.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('more than 1000 entries');
    const ok = await decompress({}, input({ data: bin(makeZip(many.slice(0, 1000)), 'ok.zip') }));
    expect(ok.status).toBe('success');
  });

  it('a tar with more entries than the limit is refused', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: text('x') }));
    const r = await decompress(
      {},
      input({ data: bin(makeTar(many), 'many.tar') }),
      limits({ maxArchiveEntries: 5 }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('more than 5 entries');
  });
});

describe('hostile and malformed archives', () => {
  it.each([
    '../evil.txt',
    'a/../../evil.txt',
    '..\\evil.txt',
    '/etc/passwd',
    '\\\\server\\share\\x',
    'C:\\Windows\\evil.dll',
    'c:evil.txt',
  ])('a zip entry named %s is refused', async (name) => {
    const zip = makeZip([
      { name: 'fine.txt', data: text('fine') },
      { name, data: text('evil') },
    ]);
    const r = await decompress({}, input({ data: bin(zip, 'evil.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('unsafe path');
  });

  it('a tar entry named ../evil.txt is refused', async () => {
    const r = await decompress(
      {},
      input({ data: bin(makeTar([{ name: '../evil.txt', data: text('x') }]), 'e.tar') }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('unsafe path');
  });

  it('compress refuses a file name that climbs out of the archive', async () => {
    const r = await compress(
      { outputFormat: 'zip', fileName: 'out.zip' },
      input({ data: bin(text('x'), '../../evil.txt') }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('unsafe path');
  });

  it('names with dots that do not climb are kept', async () => {
    const zip = makeZip([{ name: 'dir/..hidden/file..txt', data: text('ok') }]);
    const r = await decompress({}, input({ data: bin(zip, 'dots.zip') }));
    expect(r.status).toBe('success');
    expect(binaries(r.items[0][0]).file_0).toMatchObject({
      fileName: 'file..txt',
      directory: 'dir/..hidden',
    });
  });

  it.each([
    ['an encrypted entry', [{ name: 'a.txt', data: text('x'), flags: 0x0801 }], 'encrypted'],
    ['an unsupported method', [{ name: 'a.txt', data: text('x'), method: 12 }], 'method 12'],
    ['a CRC mismatch', [{ name: 'a.txt', data: text('hello'), crc: 1234 }], 'corrupt'],
    [
      'a wrong declared size',
      [{ name: 'a.txt', data: text('hello'), method: 8, declaredSize: 3 }],
      'corrupt',
    ],
  ])('a zip with %s is refused', async (_label, entries, message) => {
    const r = await decompress({}, input({ data: bin(makeZip(entries as RawEntry[]), 'bad.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain(message);
  });

  it('a truncated zip is refused', async () => {
    const zip = makeZip([{ name: 'a.txt', data: text('hello world'), method: 8 }]);
    const r = await decompress({}, input({ data: bin(zip.subarray(0, zip.length - 30), 'cut.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not a zip archive|truncated or corrupt/);
  });

  it('zip data that runs past the archive is refused', async () => {
    const zip = Buffer.from(makeZip([{ name: 'a.txt', data: text('hello world') }]));
    zip.writeUInt32LE(0x7fffffff, 30 + 5 + 11 + 20); // central compressedSize of the only entry
    const r = await decompress({}, input({ data: bin(zip, 'past.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('truncated or corrupt');
  });

  it('a truncated gzip is refused', async () => {
    const gz = gzipSync(randomBytes(4000));
    const r = await decompress({}, input({ data: bin(gz.subarray(0, 100), 'cut.gz') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('gzip');
  });

  it('a tar with a broken header checksum is refused', async () => {
    const tar = Buffer.from(makeTar([{ name: 'a.txt', data: text('x') }]));
    tar[0] = 'b'.charCodeAt(0);
    const r = await decompress({}, input({ data: bin(tar, 'bad.tar') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('tar');
  });

  it('a truncated tar is refused', async () => {
    const tar = makeTar([{ name: 'a.bin', data: randomBytes(3000) }]);
    const r = await decompress({}, input({ data: bin(tar.subarray(0, 1500), 'cut.tar') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('truncated or corrupt');
  });

  it('a file without an extension is refused', async () => {
    const r = await decompress({}, input({ data: bin(text('x')) }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('File extension not found for binary data data');
  });

  it('an unknown extension is refused', async () => {
    const r = await decompress({}, input({ data: bin(text('x'), 'archive.rar') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Unsupported archive format');
  });

  it('a missing binary field gives a clear error', async () => {
    const r = await decompress({ binaryPropertyName: 'nope' }, input({ data: bin(text('x'), 'a.zip') }));
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('nope');
  });

  it('continue on fail turns a bad item into an error item and keeps the others', async () => {
    const good = makeZip([{ name: 'a.txt', data: text('fine') }]);
    const r = await runNode(
      'core.compression',
      { operation: 'decompress' },
      [
        { json: { n: 1 }, binary: { data: bin(text('junk'), 'junk.zip') } },
        { json: { n: 2 }, binary: { data: bin(good, 'good.zip') } },
      ],
      { node: { onError: 'continueRegularOutput' } },
    );
    expect(r.status).toBe('success');
    expect((r.outputs[0][0] as DataObject).error).toContain('not a zip archive');
    expect(r.items[0][0].pairedItem).toEqual({ item: 0 });
    expect(r.outputs[0][1]).toEqual({ n: 2 });
    expect(bytesOf(binaries(r.items[0][1]).file_0).toString()).toBe('fine');
  });
});
