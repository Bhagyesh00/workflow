/**
 * Decoder for the binary event-stream framing of AWS Bedrock's streaming APIs. `HttpChatModel` feeds it
 * the response bytes when `ChatAdapter.eventStream` is set.
 *
 * A frame is: total length (u32), header length (u32), prelude CRC32 (u32), headers, payload, message
 * CRC32 (u32), big-endian. The prelude CRC covers the two lengths and is checked before the length is
 * trusted; the message CRC covers everything before it.
 */
import { crc32 } from 'node:zlib';

export interface EventStreamFrame {
  eventType: string;
  payload: unknown;
}

export interface EventStreamDecoder {
  /** the next bytes of the response; returns the frames they complete */
  push(bytes: Uint8Array): EventStreamFrame[];
  /** the response ended */
  end(): void;
}

const PRELUDE_BYTES = 12;
const CRC_BYTES = 4;
const MIN_FRAME_BYTES = PRELUDE_BYTES + CRC_BYTES;
/** AWS's limits for one frame and for its headers */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 128 * 1024;

const VALUE_BYTES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
const TYPE_BYTES_VALUE = 6;
const TYPE_STRING_VALUE = 7;

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** the frame's length, after its checksum and limits */
function readPrelude(data: Uint8Array): number {
  const view = viewOf(data);
  if (crc32(data.subarray(0, 8)) !== view.getUint32(8)) {
    throw new Error('The event stream is damaged: bad prelude checksum');
  }
  const total = view.getUint32(0);
  const headers = view.getUint32(4);
  if (
    total < MIN_FRAME_BYTES ||
    total > MAX_FRAME_BYTES ||
    headers > MAX_HEADER_BYTES ||
    headers > total - MIN_FRAME_BYTES
  ) {
    throw new Error('The event stream is damaged: impossible frame length');
  }
  return total;
}

/** string headers by name; values of other types are stepped over, since no frame field reads them */
function readHeaders(bytes: Uint8Array): Map<string, string> {
  const fail = (): never => {
    throw new Error('The event stream is damaged: bad header');
  };
  const decoder = new TextDecoder();
  const view = viewOf(bytes);
  const headers = new Map<string, string>();
  let at = 0;
  while (at < bytes.length) {
    const nameEnd = at + 1 + view.getUint8(at);
    // the type byte follows the name
    if (nameEnd >= bytes.length) fail();
    const name = decoder.decode(bytes.subarray(at + 1, nameEnd));
    const type = view.getUint8(nameEnd);
    at = nameEnd + 1;
    if (type === TYPE_BYTES_VALUE || type === TYPE_STRING_VALUE) {
      if (at + 2 > bytes.length) fail();
      const end = at + 2 + view.getUint16(at);
      if (end > bytes.length) fail();
      if (type === TYPE_STRING_VALUE) headers.set(name, decoder.decode(bytes.subarray(at + 2, end)));
      at = end;
    } else {
      const size = VALUE_BYTES[type];
      if (size === undefined || at + size > bytes.length) fail();
      at += size;
    }
  }
  return headers;
}

function readPayload(bytes: Uint8Array): unknown {
  if (!bytes.length) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The event stream held a payload that is not JSON');
  }
}

function decodeFrame(frame: Uint8Array): EventStreamFrame {
  const view = viewOf(frame);
  const crcAt = frame.length - CRC_BYTES;
  if (crc32(frame.subarray(0, crcAt)) !== view.getUint32(crcAt)) {
    throw new Error('The event stream is damaged: bad message checksum');
  }
  const payloadAt = PRELUDE_BYTES + view.getUint32(4);
  const headers = readHeaders(frame.subarray(PRELUDE_BYTES, payloadAt));
  const payload = readPayload(frame.subarray(payloadAt, crcAt));
  const messageType = headers.get(':message-type');
  if (messageType === 'exception') return { eventType: headers.get(':exception-type') ?? 'error', payload };
  if (messageType === 'error') {
    return {
      eventType: 'error',
      payload: { code: headers.get(':error-code') ?? '', message: headers.get(':error-message') ?? '' },
    };
  }
  return { eventType: headers.get(':event-type') ?? '', payload };
}

export function createEventStreamDecoder(): EventStreamDecoder {
  let chunks: Uint8Array[] = [];
  let size = 0;
  /** bytes the next step needs: the prelude, then the frame the prelude announced */
  let needed = PRELUDE_BYTES;
  let total: number | undefined;

  // pieces are joined only once a step can run, so tiny chunks do not copy the same bytes repeatedly
  const joined = (): Uint8Array => {
    if (chunks.length === 1) return chunks[0];
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    chunks = [data];
    return data;
  };

  return {
    push(bytes) {
      if (bytes.length) {
        chunks.push(bytes);
        size += bytes.length;
      }
      const frames: EventStreamFrame[] = [];
      while (size >= needed) {
        const data = joined();
        if (total === undefined) {
          total = readPrelude(data);
          needed = total;
          continue;
        }
        frames.push(decodeFrame(data.subarray(0, total)));
        const rest = data.subarray(total);
        chunks = rest.length ? [rest] : [];
        size = rest.length;
        total = undefined;
        needed = PRELUDE_BYTES;
      }
      return frames;
    },
    end() {
      if (size > 0) throw new Error('The event stream ended inside a frame');
    },
  };
}
