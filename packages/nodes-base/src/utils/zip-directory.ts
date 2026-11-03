/**
 * Reads the central directory of a zip archive without inflating anything, so callers can check the
 * entry count and the declared sizes before they decompress (Compression unzip, the xlsx/ods guard).
 *
 * The declared sizes are what the archive claims; a hostile archive can lie, so callers still bound
 * the real inflated bytes (zlib `maxOutputLength`). ZIP64 and multi-disk archives are refused.
 */

export interface ZipDirectoryEntry {
  /** the path inside the archive; a trailing '/' marks a directory */
  name: string;
  /** compression method: 0 store, 8 deflate (others are left to the caller to refuse) */
  method: number;
  /** general purpose flags: bit 0 encrypted, bit 3 data descriptor, bit 11 UTF-8 name */
  flags: number;
  compressedSize: number;
  /** the uncompressed size the archive declares */
  declaredSize: number;
  crc32: number;
  /** where the entry's local header starts; its data follows that header */
  localHeaderOffset: number;
}

export class ZipDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipDirectoryError';
  }
}

const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

const notZip = () => new ZipDirectoryError('The file is not a zip archive');
const corrupt = () => new ZipDirectoryError('The zip archive is truncated or corrupt');
const zip64 = () => new ZipDirectoryError('ZIP64 archives are not supported');

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/** the entries listed in the central directory, in archive order; throws ZipDirectoryError */
export function readZipDirectory(bytes: Uint8Array, options: { maxEntries: number }): ZipDirectoryEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);

  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ZipDirectoryError('Multi-disk zip archives are not supported');
  }
  const entriesOnDisk = view.getUint16(end + 8, true);
  const total = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    total === 0xffff ||
    entriesOnDisk === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw zip64();
  }
  if (entriesOnDisk !== total) throw corrupt();
  if (total > options.maxEntries) {
    throw new ZipDirectoryError(`The zip archive has more than ${options.maxEntries} entries`);
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw corrupt();

  const entries: ZipDirectoryEntry[] = [];
  let p = directoryOffset;
  for (let i = 0; i < total; i++) {
    if (p + CENTRAL_SIZE > directoryEnd || view.getUint32(p, true) !== CENTRAL_SIGNATURE) throw corrupt();
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc32 = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const declaredSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const nameStart = p + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directoryEnd) throw corrupt();
    if (
      compressedSize === 0xffffffff ||
      declaredSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      hasExtraField(view, extraStart, extraLength, ZIP64_EXTRA_ID)
    ) {
      throw zip64();
    }
    if (localHeaderOffset + LOCAL_SIZE > directoryOffset) throw corrupt();
    const nameBytes = bytes.subarray(nameStart, extraStart);
    entries.push({
      // bit 11 marks a UTF-8 name; older tools wrote names in a single-byte code page
      name: (flags & 0x0800 ? utf8 : latin1).decode(nameBytes),
      method,
      flags,
      compressedSize,
      declaredSize,
      crc32,
      localHeaderOffset,
    });
    p = next;
  }
  return entries;
}

/** offset of the end of central directory record, searched backwards past an archive comment */
function findEndRecord(view: DataView): number {
  const length = view.byteLength;
  if (length < END_SIZE) throw notZip();
  const lowest = Math.max(0, length - END_SIZE - MAX_COMMENT);
  for (let p = length - END_SIZE; p >= lowest; p--) {
    if (view.getUint32(p, true) !== END_SIGNATURE) continue;
    // a signature inside the comment does not end exactly at the end of the file
    if (p + END_SIZE + view.getUint16(p + 20, true) === length) return p;
  }
  throw notZip();
}

function hasExtraField(view: DataView, start: number, length: number, id: number): boolean {
  let p = start;
  const end = start + length;
  while (p + 4 <= end) {
    if (view.getUint16(p, true) === id) return true;
    p += 4 + view.getUint16(p + 2, true);
  }
  return false;
}
