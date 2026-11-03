/**
 * Binary previews (P3-08): which binaries the editor can show, and how big they are.
 *
 * The renderer is chosen from the base mime type against a fixed allow-list, never from
 * `fileType` (a node sets that freely). SVG and HTML are never in the list: both can carry
 * script. The bytes are shown from a Blob typed with the allow-listed mime type, so the browser
 * renders exactly that kind of content (native <img>, <audio> or its PDF viewer).
 */
import type { BinaryData } from '@workflow/workflow';

export type PreviewKind = 'image' | 'audio' | 'pdf';

/** allow-listed base mime type -> renderer */
const PREVIEW_TYPES: Readonly<Record<string, PreviewKind>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/avif': 'image',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/wave': 'audio',
  'audio/x-wav': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'application/pdf': 'pdf',
};

/** previews load at most this many bytes; bigger files are Download only */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** file cards show an image thumbnail only below this size */
export const THUMBNAIL_MAX_BYTES = 1024 * 1024;

/** `Image/PNG; charset=binary` -> `image/png` */
export function baseMimeType(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/** The allow-listed mime type of `binary`, or null when the editor must not render it. */
export function previewMimeType(binary: Pick<BinaryData, 'mimeType'>): string | null {
  const mime = baseMimeType(binary.mimeType);
  return Object.hasOwn(PREVIEW_TYPES, mime) ? mime : null;
}

export function previewKind(binary: Pick<BinaryData, 'mimeType'>): PreviewKind | null {
  const mime = previewMimeType(binary);
  return mime ? PREVIEW_TYPES[mime] : null;
}

/** Size in bytes: `fileSize` when set, else decoded from inline base64; null when unknown. */
export function binarySize(binary: Pick<BinaryData, 'data' | 'fileSize'>): number | null {
  if (typeof binary.fileSize === 'number' && Number.isFinite(binary.fileSize) && binary.fileSize >= 0) {
    return binary.fileSize;
  }
  const data = binary.data ?? '';
  if (!data) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export type PreviewAccess =
  | { kind: PreviewKind; mimeType: string; thumbnail: boolean }
  | { kind: null; reason: 'type' | 'size' };

/** What a file card may offer for `binary`: View (and a thumbnail for small images), or Download only. */
export function previewAccess(binary: BinaryData): PreviewAccess {
  const mimeType = previewMimeType(binary);
  if (!mimeType) return { kind: null, reason: 'type' };
  const size = binarySize(binary);
  if (size !== null && size > PREVIEW_MAX_BYTES) return { kind: null, reason: 'size' };
  const kind = PREVIEW_TYPES[mimeType];
  return { kind, mimeType, thumbnail: kind === 'image' && size !== null && size < THUMBNAIL_MAX_BYTES };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

async function readHead(blob: Blob, length: number): Promise<Uint8Array> {
  const head = blob.slice(0, length);
  if (typeof head.arrayBuffer === 'function') return new Uint8Array(await head.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(head);
  });
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** True when the bytes start with the PDF header `%PDF-`. */
export async function isPdfBytes(blob: Blob): Promise<boolean> {
  const head = await readHead(blob, PDF_MAGIC.length);
  return head.length === PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => head[i] === byte);
}

/** The file name a download gets: the binary's own name, else `<property>.<extension>`. */
export function downloadName(
  binary: Pick<BinaryData, 'fileName' | 'fileExtension'>,
  property: string,
): string {
  if (binary.fileName) return binary.fileName;
  return binary.fileExtension ? `${property}.${binary.fileExtension}` : property;
}
