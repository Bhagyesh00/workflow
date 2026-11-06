/**
 * kafkajs only knows gzip. This registers Snappy, LZ4 and Zstandard, both ways, in the framing the Kafka
 * clients and brokers use, so topics written by any producer can be read and written.
 */
import { createRequire } from 'node:module';
import kafkajs from 'kafkajs';

const { CompressionCodecs, CompressionTypes } = kafkajs;

// neither package ships type declarations
const require = createRequire(import.meta.url);

interface SnappyApi {
  compress(data: Uint8Array): Uint8Array;
  uncompress(data: Uint8Array): Uint8Array;
}

interface Lz4Api {
  compressBound(size: number): number;
  compressBlock(
    source: Uint8Array,
    target: Uint8Array,
    sourceIndex: number,
    sourceLength: number,
    hashTable: Uint32Array,
  ): number;
  decompress(data: Uint8Array): Uint8Array;
}

interface ZstdApi {
  init(): Promise<void>;
  compress(data: Uint8Array, level?: number): Uint8Array;
  decompress(data: Uint8Array, options?: { defaultHeapSize: number }): Uint8Array;
}

const snappy = require('snappyjs') as SnappyApi;
const lz4 = require('lz4js') as Lz4Api;
const xxh32 = require('lz4js/xxh32.js') as {
  hash(seed: number, data: Uint8Array, index: number, length: number): number;
};

/** the stream header of Snappy's Java library, which the Kafka clients write: magic, version, compatible version */
const XERIAL_MAGIC = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]);
const XERIAL_VERSION = 1;
const XERIAL_HEADER_BYTES = XERIAL_MAGIC.length + 8;
const XERIAL_BLOCK_BYTES = 32 * 1024;

export function compressSnappy(data: Buffer): Buffer {
  const header = Buffer.alloc(XERIAL_HEADER_BYTES);
  XERIAL_MAGIC.copy(header);
  header.writeInt32BE(XERIAL_VERSION, XERIAL_MAGIC.length);
  header.writeInt32BE(XERIAL_VERSION, XERIAL_MAGIC.length + 4);
  const parts = [header];
  for (let offset = 0; offset < data.length; offset += XERIAL_BLOCK_BYTES) {
    const block = snappy.compress(data.subarray(offset, offset + XERIAL_BLOCK_BYTES));
    const size = Buffer.alloc(4);
    size.writeInt32BE(block.length);
    parts.push(size, Buffer.from(block));
  }
  return Buffer.concat(parts);
}

/** a xerial stream, or one bare Snappy block as some producers send */
export function decompressSnappy(data: Buffer): Buffer {
  if (!data.subarray(0, XERIAL_MAGIC.length).equals(XERIAL_MAGIC)) {
    return Buffer.from(snappy.uncompress(data));
  }
  const parts: Buffer[] = [];
  let offset = XERIAL_HEADER_BYTES;
  while (offset < data.length) {
    const size = data.readInt32BE(offset);
    offset += 4;
    parts.push(Buffer.from(snappy.uncompress(data.subarray(offset, offset + size))));
    offset += size;
  }
  return Buffer.concat(parts);
}

const LZ4_MAGIC = 0x184d2204;
/** frame version 01 and independent blocks: the Kafka reader refuses dependent blocks */
const LZ4_FLG = 0x60;
/** blocks of at most 64 KiB, what the Kafka writer uses */
const LZ4_BD = 0x40;
const LZ4_BLOCK_BYTES = 64 * 1024;
const LZ4_STORED_FLAG = 0x80000000;

/**
 * A LZ4 frame the Kafka reader takes. lz4js's own frame writer does not set the independence bit and
 * keeps its match table between blocks, so this writes the frame around lz4js's block compressor and
 * clears the table per block.
 */
export function compressLz4(data: Buffer): Buffer {
  const header = Buffer.alloc(7);
  header.writeUInt32LE(LZ4_MAGIC, 0);
  header[4] = LZ4_FLG;
  header[5] = LZ4_BD;
  header[6] = (xxh32.hash(0, header, 4, 2) >>> 8) & 0xff;

  const parts: Buffer[] = [header];
  const target = new Uint8Array(lz4.compressBound(LZ4_BLOCK_BYTES));
  const hashTable = new Uint32Array(1 << 16);
  for (let offset = 0; offset < data.length; offset += LZ4_BLOCK_BYTES) {
    const blockBytes = Math.min(LZ4_BLOCK_BYTES, data.length - offset);
    hashTable.fill(0);
    const compressed = lz4.compressBlock(data, target, offset, blockBytes, hashTable);
    const size = Buffer.alloc(4);
    if (compressed > 0 && compressed < blockBytes) {
      size.writeUInt32LE(compressed);
      parts.push(size, Buffer.from(target.subarray(0, compressed)));
    } else {
      size.writeUInt32LE((LZ4_STORED_FLAG | blockBytes) >>> 0);
      parts.push(size, data.subarray(offset, offset + blockBytes));
    }
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

export function decompressLz4(data: Buffer): Buffer {
  return Buffer.from(lz4.decompress(data));
}

const ZSTD_LEVEL = 3;
const ZSTD_FIRST_BUFFER_BYTES = 1024 * 1024;
/** a frame that does not declare its size may grow its buffer up to this */
const ZSTD_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
/** ZSTD_error_dstSize_tooSmall as the wasm build reports it, signed or not */
const ZSTD_TOO_SMALL = /code (-70|4294967226)$/;

let zstd: Promise<ZstdApi> | undefined;

/** the wasm loads when a topic first needs it */
function loadZstd(): Promise<ZstdApi> {
  zstd ??= import('@bokuweb/zstd-wasm').then(async (loaded) => {
    const module = loaded as unknown as ZstdApi & { default?: ZstdApi };
    const api = module.default ?? module;
    await api.init();
    return api;
  });
  return zstd;
}

export async function compressZstd(data: Buffer): Promise<Buffer> {
  const api = await loadZstd();
  return Buffer.from(api.compress(data, ZSTD_LEVEL));
}

export async function decompressZstd(data: Buffer): Promise<Buffer> {
  const api = await loadZstd();
  // a streaming writer, like the Kafka clients, does not declare the size: grow until it fits
  for (let size = ZSTD_FIRST_BUFFER_BYTES; ; size *= 2) {
    try {
      return Buffer.from(api.decompress(data, { defaultHeapSize: size }));
    } catch (error) {
      if (size >= ZSTD_MAX_BUFFER_BYTES || !ZSTD_TOO_SMALL.test((error as Error).message)) throw error;
    }
  }
}

/** what kafkajs hands a codec to compress */
interface Encoder {
  buffer: Buffer;
}

CompressionCodecs[CompressionTypes.Snappy] = () => ({
  compress: async (encoder: Encoder) => compressSnappy(encoder.buffer),
  decompress: async (data: Buffer) => decompressSnappy(data),
});

CompressionCodecs[CompressionTypes.LZ4] = () => ({
  compress: async (encoder: Encoder) => compressLz4(encoder.buffer),
  decompress: async (data: Buffer) => decompressLz4(data),
});

CompressionCodecs[CompressionTypes.ZSTD] = () => ({
  compress: async (encoder: Encoder) => compressZstd(encoder.buffer),
  decompress: async (data: Buffer) => decompressZstd(data),
});
