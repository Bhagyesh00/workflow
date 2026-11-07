/**
 * Decoder for the binary event-stream framing of AWS Bedrock's streaming APIs. Stub: L11 fills it.
 * `HttpChatModel` feeds it the response bytes when `ChatAdapter.eventStream` is set.
 */
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

export function createEventStreamDecoder(): EventStreamDecoder {
  throw new Error('not implemented (L11)');
}
