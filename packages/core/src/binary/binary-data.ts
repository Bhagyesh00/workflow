/**
 * Binary data storage. `inline` keeps payloads base64-encoded inside items (fine for small files);
 * `filesystem` writes them to disk and keeps only a reference in run data.
 * An S3-compatible store implements the same interface (server package).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BinaryData } from '@workflow/workflow';
import type { BinaryDataStore } from '../engine/services';

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
};

export function fileTypeOf(mimeType: string): BinaryData['fileType'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'text/html') return 'html';
  if (mimeType.startsWith('text/')) return 'text';
  return undefined;
}

function describe(data: Uint8Array, meta: { fileName?: string; mimeType: string }): Omit<BinaryData, 'data'> {
  const ext = meta.fileName?.includes('.') ? meta.fileName.split('.').pop() : EXTENSIONS[meta.mimeType];
  return {
    mimeType: meta.mimeType,
    fileName: meta.fileName,
    fileExtension: ext,
    fileType: fileTypeOf(meta.mimeType),
    fileSize: data.byteLength,
  };
}

export class InlineBinaryDataStore implements BinaryDataStore {
  async store(data: Uint8Array, meta: { fileName?: string; mimeType: string }): Promise<BinaryData> {
    return { ...describe(data, meta), data: Buffer.from(data).toString('base64') };
  }

  async getBuffer(binary: BinaryData): Promise<Uint8Array> {
    if (binary.id) throw new Error('Inline store cannot resolve stored binary references');
    return Buffer.from(binary.data, 'base64');
  }
}

export class FileSystemBinaryDataStore implements BinaryDataStore {
  constructor(
    private readonly baseDir: string,
    private readonly tenantId: string,
    /** payloads below this size stay inline */
    private readonly inlineThreshold = 64 * 1024,
  ) {}

  async store(
    data: Uint8Array,
    meta: { fileName?: string; mimeType: string; executionId: string },
  ): Promise<BinaryData> {
    if (data.byteLength <= this.inlineThreshold) {
      return { ...describe(data, meta), data: Buffer.from(data).toString('base64') };
    }
    // ids always use '/' so they are the same on every platform
    const rel = path.posix.join(this.tenantId, meta.executionId, randomUUID());
    const abs = path.join(this.baseDir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return { ...describe(data, meta), data: '', id: `fs:${rel}` };
  }

  async getBuffer(binary: BinaryData): Promise<Uint8Array> {
    if (!binary.id) return Buffer.from(binary.data, 'base64');
    if (!binary.id.startsWith('fs:')) throw new Error(`Unsupported binary reference "${binary.id}"`);
    const parts = binary.id.slice(3).split('/');
    const unsafe = (part: string) => !part || part === '.' || part === '..' || /[\\:]/.test(part);
    if (parts.length < 2 || parts[0] !== this.tenantId || parts.some(unsafe)) {
      throw new Error('Binary reference does not belong to this tenant');
    }
    return readFile(path.join(this.baseDir, ...parts));
  }
}
