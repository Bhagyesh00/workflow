/**
 * Server-Sent Events parser (WHATWG "event stream interpretation"), written for the guarded byte stream
 * of ctx.helpers.httpRequest. Feed it chunks as they arrive; it returns the events completed by each
 * chunk. Lines end with LF, CRLF or CR (a CR at the end of a chunk waits for a possible LF). One event
 * is capped at `maxEventBytes`: a stream that goes past it is refused instead of buffered.
 */

export interface SseEvent {
  /** the `event` field, `message` when the stream gave none */
  type: string;
  /** the `data` lines joined with LF */
  data: string;
  /** the last event ID in effect (it persists across events until the stream sets a new one) */
  lastEventId: string;
}

export class SseEventTooLargeError extends Error {
  constructor(limit: number) {
    super(`A server-sent event is larger than ${limit} bytes`);
    this.name = 'SseEventTooLargeError';
  }
}

export interface SseParserOptions {
  /** bytes one event (its fields, until the blank line) may take; default 10 MiB */
  maxEventBytes?: number;
  /** the event ID to start from (a reconnect keeps it) */
  lastEventId?: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly maxEventBytes: number;
  /** the start of the line being read, in pieces: joined once when the line ends */
  private pending: string[] = [];
  private pendingBytes = 0;
  private skipLf = false;
  private started = false;
  private dataLines: string[] = [];
  private eventType = '';
  private eventBytes = 0;
  private id: string;
  private retryValue: number | undefined;

  constructor(options: SseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? 10 * 1024 * 1024;
    this.id = options.lastEventId ?? '';
  }

  /** the last event ID seen; send it as `Last-Event-ID` when reconnecting */
  get lastEventId(): string {
    return this.id;
  }

  /** the newest `retry` value (milliseconds) the stream set, if any */
  get retryMs(): number | undefined {
    return this.retryValue;
  }

  feed(chunk: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.skipLf && text.length > 0) {
      if (text.charCodeAt(0) === 0x0a) text = text.slice(1);
      this.skipLf = false;
    }
    // only the new text is scanned, so a line that never ends costs time in step with what arrives
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x0a && c !== 0x0d) continue;
      let line = text.slice(start, i);
      if (this.pending.length > 0) {
        this.pending.push(line);
        line = this.pending.join('');
        this.pending = [];
        this.pendingBytes = 0;
      }
      if (c === 0x0d) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 0x0a) i++;
        } else {
          this.skipLf = true;
        }
      }
      start = i + 1;
      const event = this.line(line);
      if (event) events.push(event);
    }
    if (start < text.length) {
      const tail = start === 0 ? text : text.slice(start);
      this.pending.push(tail);
      this.pendingBytes += Buffer.byteLength(tail);
    }
    // a line that never ends counts toward the same cap
    if (this.eventBytes + this.pendingBytes > this.maxEventBytes) {
      throw new SseEventTooLargeError(this.maxEventBytes);
    }
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    this.eventBytes += Buffer.byteLength(line) + 1;
    if (this.eventBytes > this.maxEventBytes) throw new SseEventTooLargeError(this.maxEventBytes);
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.retryValue = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const lines = this.dataLines;
    const type = this.eventType;
    this.dataLines = [];
    this.eventType = '';
    this.eventBytes = 0;
    if (lines.length === 0) return undefined;
    return { type: type || 'message', data: lines.join('\n'), lastEventId: this.id };
  }
}
