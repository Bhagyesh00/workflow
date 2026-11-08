/**
 * P5-67: a thread's events, `GET /rest/assistant/events/:threadId?lastEventId=<n>`, read as server-sent events
 * through `fetch` with the tenant header (`EventSource` cannot send headers). The demo build has no server: it
 * swaps the connector (`setAssistantStreamConnector` in demo/install.ts) for scripted events.
 *
 * L2 writes the server stream: its own small SSE parser, the highest id seen (lower ones are dropped), reconnect
 * with backoff from that id, stop on abort.
 */
import type { AssistantEvent } from '@workflow/workflow';

/**
 * Streams the events of `threadId` after event id `afterId` and calls `onEvent` for each one until `signal`
 * aborts. Durable events carry their id; live-only ones (`text-delta`, `status`) carry none.
 */
export type AssistantStreamConnector = (
  threadId: string,
  afterId: number,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

let connector: AssistantStreamConnector | null = null;

/** Replace the stream (the demo's seam); `null` goes back to the server stream. */
export function setAssistantStreamConnector(next: AssistantStreamConnector | null): void {
  connector = next;
}

/** the connector set last, or null for the server stream */
export function getAssistantStreamConnector(): AssistantStreamConnector | null {
  return connector;
}

/** the server stream (L2) */
async function serverStream(
  _threadId: string,
  _afterId: number,
  _onEvent: (event: AssistantEvent) => void,
  _signal: AbortSignal,
): Promise<void> {
  throw new Error('not implemented (L2)');
}

/** Streams a thread's events: through the connector when one is set, else from the server. */
export function streamAssistantEvents(
  threadId: string,
  afterId: number,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return (connector ?? serverStream)(threadId, afterId, onEvent, signal);
}
