/**
 * In-memory zip, gzip and tar for the Compression node (own container code on node:zlib, no ctx).
 *
 * Reading is bounded: every inflate runs with zlib `maxOutputLength` set to what is left of the
 * byte budget, so the real inflated bytes are capped, not the sizes an archive claims. Declared
 * sizes only give an early refusal. Entry counts are capped too. Entry names are refused when
 * they are absolute or climb out with `..`; callers keep names as file metadata only.
 */
import { kMaxLength } from 'node:buffer';
import { promisify } from 'node:util';
import { crc32, deflateRaw, gunzip, gzip, inflateRaw } from 'node:zlib';
import { readZipDirectory, ZipDirectoryError } from './zip-directory';

const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ArchiveFile {
  /** path inside the archive, '/' separated */
  name: string;
  data: Uint8Array;
}

export interface ArchiveLimits {
  /** total bytes one archive may expand to */
  maxBytes: number;
  /** entries one archive may hold */
  maxEntries: number;
}

/** a malformed, unsupported or unsafe archive */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** the archive is larger than the instance allows */
export class ArchiveLimitError extends ArchiveError {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveLimitError';
  }
}

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  return bytes % MB === 0 ? `${bytes / MB} MB` : `${bytes} bytes`;
}

const sizeLimitError = (limits: ArchiveLimits) =>
  new ArchiveLimitError(`The archive expands beyond the size limit of ${formatBytes(limits.maxBytes)}`);
const entryLimitError = (limits: ArchiveLimits) =>
  new ArchiveLimitError(`The archive has more than ${limits.maxEntries} entries`);

/** bytes still allowed for one archive */
class Budget {
  private used = 0;
  constructor(readonly limits: ArchiveLimits) {}
  get remaining() {
    return Math.max(0, this.limits.maxBytes - this.used);
  }
  take(bytes: number) {
    if (bytes > this.remaining) throw sizeLimitError(this.limits);
    this.used += bytes;
  }
}

/** true for a name that is absolute, has a drive letter, a NUL, or a `..` segment */
export function isUnsafeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0')) return true;
  if (/^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === '..');
}

export function assertSafeEntryName(name: string): void {
  if (isUnsafeEntryName(name)) {
    const shown = name.replace(/\0/g, '\\0').slice(0, 200);
    throw new ArchiveError(`The archive entry "${shown}" has an unsafe path`);
  }
}

/** splits an entry path into the file name and its directory (undefined at the top) */
export function splitEntryName(name: string): { fileName: string; directory?: string } {
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.pop() ?? name;
  return parts.length ? { fileName, directory: parts.join('/') } : { fileName };
}

/** macOS resource-fork folders that zip and tar tools on a Mac add; skipped like n8n */
const isMacJunk = (name: string) => name.split(/[\\/]/).includes('__MACOSX');

function zlibFailure(error: unknown, limits: ArchiveLimits, what: string): Error {
  if ((error as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') return sizeLimitError(limits);
  return new ArchiveError(`The ${what} is truncated or corrupt`);
}

/** zlib's maxOutputLength must be 1..kMaxLength; the budget check after inflating does the rest */
const outputCap = (bytes: number) => Math.max(1, Math.min(bytes, kMaxLength));

// ---------------------------------------------------------------------------------------------
// zip

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20;
/** made by: Unix (3), so readers apply the 0644 file mode below */
const MADE_BY = (3 << 8) | VERSION;
const FILE_MODE = 0o100644;

/** extensions whose data is compressed already; zip stores them instead of deflating */
const STORED_EXTENSIONS = new Set([
  '7z',
  'aac',
  'apk',
  'avi',
  'avif',
  'bz2',
  'docx',
  'epub',
  'gif',
  'gz',
  'gzip',
  'heic',
  'jar',
  'jpeg',
  'jpg',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'odp',
  'ods',
  'odt',
  'ogg',
  'pdf',
  'png',
  'pptx',
  'rar',
  'tgz',
  'webm',
  'webp',
  'xlsx',
  'xz',
  'zip',
  'zst',
]);

const extensionOf = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** a zip archive (deflate level 6, or store for already-compressed files); no ZIP64 */
export async function zipFiles(files: ArchiveFile[], now = new Date()): Promise<Uint8Array> {
  if (files.length > 0xffff) throw new ArchiveError('A zip archive can hold at most 65535 files');
  const stamp = dosDateTime(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    assertSafeEntryName(file.name);
    const name = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    if (name.length > 0xffff) throw new ArchiveError('A file name is too long for a zip archive');
    const store = STORED_EXTENSIONS.has(extensionOf(file.name));
    const payload = store ? file.data : await deflateRawAsync(file.data, { level: 6 });
    const crc = crc32(file.data);
    if (file.data.byteLength > 0xfffffffe || payload.byteLength > 0xfffffffe || offset > 0xfffffffe) {
      throw new ArchiveError('The files are too large for a zip archive without ZIP64');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(file.data.byteLength, 22);
    local.writeUInt16LE(name.length, 26);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    record.writeUInt16LE(MADE_BY, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8_FLAG, 8);
    record.writeUInt16LE(store ? 0 : 8, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.byteLength, 20);
    record.writeUInt32LE(file.data.byteLength, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(FILE_MODE * 0x10000, 38);
    record.writeUInt32LE(offset, 42);

    parts.push(local, name, payload);
    central.push(record, name);
    offset += local.length + name.length + payload.byteLength;
  }
  const directorySize = central.reduce((sum, b) => sum + b.byteLength, 0);
  if (offset + directorySize > 0xfffffffe) {
    throw new ArchiveError('The files are too large for a zip archive without ZIP64');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/**
 * The files of a zip archive (directories and __MACOSX entries skipped). Refuses encrypted entries,
 * methods other than store and deflate, ZIP64, unsafe names, CRC or size mismatches, more entries
 * than allowed and more inflated bytes than allowed.
 */
export async function unzipBounded(bytes: Uint8Array, limits: ArchiveLimits): Promise<ArchiveFile[]> {
  let entries: ReturnType<typeof readZipDirectory>;
  try {
    entries = readZipDirectory(bytes, { maxEntries: limits.maxEntries });
  } catch (error) {
    if (error instanceof ZipDirectoryError && error.message.includes('more than'))
      throw entryLimitError(limits);
    if (error instanceof ZipDirectoryError) throw new ArchiveError(error.message);
    throw error;
  }

  // everything that can be refused without inflating is refused first
  let declared = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (isDirectory(entry.name) || isMacJunk(entry.name)) continue;
    if (entry.flags & 0x0001) throw new ArchiveError(`The zip entry "${entry.name}" is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ArchiveError(
        `The zip entry "${entry.name}" uses compression method ${entry.method}; only store and deflate are supported`,
      );
    }
    declared += entry.declaredSize;
  }
  if (declared > limits.maxBytes) throw sizeLimitError(limits);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget = new Budget(limits);
  const files: ArchiveFile[] = [];
  for (const entry of entries) {
    if (isDirectory(entry.name) || isMacJunk(entry.name)) continue;
    const corrupt = () => new ArchiveError(`The zip entry "${entry.name}" is truncated or corrupt`);
    const at = entry.localHeaderOffset;
    if (at + 30 > bytes.byteLength || view.getUint32(at, true) !== LOCAL_SIGNATURE) throw corrupt();
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.byteLength) throw corrupt();
    const raw = bytes.subarray(start, end);

    let data: Uint8Array;
    if (entry.method === 0) {
      budget.take(raw.byteLength);
      data = raw;
    } else {
      try {
        data = await inflateRawAsync(raw, { maxOutputLength: outputCap(budget.remaining) });
      } catch (error) {
        throw zlibFailure(error, limits, `zip entry "${entry.name}"`);
      }
      budget.take(data.byteLength);
    }
    if (data.byteLength !== entry.declaredSize || crc32(data) !== entry.crc32) throw corrupt();
    files.push({ name: entry.name, data });
  }
  return files;
}

const isDirectory = (name: string) => name.endsWith('/') || name.endsWith('\\');

// ---------------------------------------------------------------------------------------------
// gzip

export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  return gzipAsync(data);
}

/** the inflated bytes of a gzip file, at most limits.maxBytes */
export async function gunzipBounded(bytes: Uint8Array, limits: ArchiveLimits): Promise<Uint8Array> {
  if (bytes.byteLength < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new ArchiveError('The file is not a gzip file');
  }
  try {
    const data = await gunzipAsync(bytes, { maxOutputLength: outputCap(limits.maxBytes) });
    if (data.byteLength > limits.maxBytes) throw sizeLimitError(limits);
    return data;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw zlibFailure(error, limits, 'gzip file');
  }
}

// ---------------------------------------------------------------------------------------------
// tar (ustar, with GNU long names and PAX path records on read; PAX for long names on write)

const BLOCK = 512;
const utf8 = new TextDecoder('utf-8');

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

function writeOctal(header: Buffer, value: number, offset: number, length: number) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarHeader(
  name: Buffer,
  prefix: Buffer | undefined,
  size: number,
  type: string,
  mtime: number,
): Buffer {
  const header = Buffer.alloc(BLOCK);
  name.copy(header, 0);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtime, 136, 12);
  header.write('        ', 148, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  prefix?.copy(header, 345);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** one PAX record `<len> path=<value>\n`, where len counts the whole record including itself */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** ustar name/prefix split at a '/', when both parts fit */
function splitUstar(name: Buffer): { name: Buffer; prefix?: Buffer } | undefined {
  if (name.length <= 100) return { name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== 0x2f) continue;
    if (i > 155) continue;
    if (name.length - i - 1 > 100) return undefined;
    if (name.length - i - 1 === 0) return undefined;
    return { prefix: name.subarray(0, i), name: name.subarray(i + 1) };
  }
  return undefined;
}

export async function tarFiles(files: ArchiveFile[], now = new Date()): Promise<Uint8Array> {
  const mtime = Math.floor(now.getTime() / 1000);
  const parts: Uint8Array[] = [];
  for (const file of files) {
    assertSafeEntryName(file.name);
    const path = file.name.replace(/\\/g, '/');
    const name = Buffer.from(path, 'utf8');
    const split = splitUstar(name);
    if (split) {
      parts.push(tarHeader(split.name, split.prefix, file.data.byteLength, '0', mtime));
    } else {
      const record = paxRecord('path', path);
      const short = Buffer.from(
        `PaxHeader/${path.split('/').pop() ?? 'file'}`.slice(0, 100),
        'utf8',
      ).subarray(0, 100);
      parts.push(
        tarHeader(short, undefined, record.length, 'x', mtime),
        record,
        Buffer.alloc(padding(record.length)),
      );
      parts.push(tarHeader(name.subarray(0, 100), undefined, file.data.byteLength, '0', mtime));
    }
    parts.push(file.data, Buffer.alloc(padding(file.data.byteLength)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function cString(bytes: Uint8Array, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return utf8.decode(nul === -1 ? field : field.subarray(0, nul));
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number | undefined {
  // a set high bit marks GNU base-256 (sizes above 8 GiB): never needed in memory
  if (bytes[offset]! & 0x80) return undefined;
  const text = cString(bytes, offset, length).replace(/[\s]+/g, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return undefined;
  return Number.parseInt(text, 8);
}

function checksumOk(header: Uint8Array): boolean {
  const stored = parseOctal(header, 148, 8);
  if (stored === undefined) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === stored;
}

function paxPath(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let p = 0;
  while (p < data.length) {
    const space = data.indexOf(0x20, p);
    if (space === -1) break;
    const length = Number(utf8.decode(data.subarray(p, space)));
    if (!Number.isInteger(length) || length <= space - p || p + length > data.length) {
      throw new ArchiveError('The tar archive has a corrupt PAX header');
    }
    const record = utf8.decode(data.subarray(space + 1, p + length - 1));
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    p += length;
  }
  return path;
}

const isZeroBlock = (block: Uint8Array) => block.every((b) => b === 0);

/** the regular files of a tar archive (directories, links and __MACOSX entries skipped) */
export function untarBounded(bytes: Uint8Array, limits: ArchiveLimits): ArchiveFile[] {
  const corrupt = () => new ArchiveError('The tar archive is truncated or corrupt');
  const budget = new Budget(limits);
  const files: ArchiveFile[] = [];
  let entries = 0;
  let longName: string | undefined;
  let pax: string | undefined;
  let p = 0;
  while (p + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(p, p + BLOCK);
    if (isZeroBlock(header)) break;
    if (!checksumOk(header)) {
      throw p === 0 ? new ArchiveError('The file is not a tar archive') : corrupt();
    }
    const size = parseOctal(header, 124, 12);
    if (size === undefined) throw corrupt();
    const start = p + BLOCK;
    const end = start + size;
    if (end > bytes.byteLength) throw corrupt();
    const data = bytes.subarray(start, end);
    p = end + padding(size);

    const type = String.fromCharCode(header[156]!);
    if (type === 'L') {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      pax = paxPath(data) ?? pax;
      continue;
    }
    if (type === 'g') continue;

    let name = cString(header, 0, 100);
    // the POSIX ustar magic carries a name prefix; GNU's "ustar  " uses those bytes for other fields
    if (cString(header, 257, 6) === 'ustar' && header[262] === 0) {
      const prefix = cString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax ?? longName ?? name;
    pax = undefined;
    longName = undefined;

    entries++;
    if (entries > limits.maxEntries) throw entryLimitError(limits);
    assertSafeEntryName(name);
    const regular = type === '0' || type === '\0' || type === '7';
    if (!regular || isDirectory(name) || isMacJunk(name)) continue;
    budget.take(size);
    files.push({ name, data });
  }
  if (p === 0 && bytes.byteLength < BLOCK) throw new ArchiveError('The file is not a tar archive');
  return files;
}
