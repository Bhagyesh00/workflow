/**
 * Live events over SSE (`GET /rest/push`). The connection factory is injectable so tests and the
 * demo build can feed events without a server.
 */
import { confirmTenant, getCurrentTenant } from './client';
import { PUSH_EVENT_TYPES, type PushEvent, type PushEventType } from './types';

export type PushStatus = 'connecting' | 'open' | 'error';

export interface PushConnection {
  close(): void;
}

export type PushConnector = (
  onEvent: (event: PushEvent) => void,
  onStatus: (status: PushStatus) => void,
) => PushConnection;

/** Parse one SSE message; returns null for malformed payloads instead of throwing. */
export function parsePushMessage(type: string, raw: string): PushEvent | null {
  if (!(PUSH_EVENT_TYPES as string[]).includes(type)) return null;
  try {
    const data = raw ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object') return null;
    return { type: type as PushEventType, data } as PushEvent;
  } catch {
    return null;
  }
}

export const eventSourceConnector: PushConnector = (onEvent, onStatus) => {
  if (typeof EventSource === 'undefined') {
    onStatus('error');
    return { close() {} };
  }
  onStatus('connecting');
  // EventSource cannot set headers: the URL names the workspace this tab shows, so a reconnect after
  // a switch in another tab is refused instead of silently streaming the other workspace's events
  const tenantId = getCurrentTenant();
  const url = tenantId ? `/rest/push?tenantId=${encodeURIComponent(tenantId)}` : '/rest/push';
  const source = new EventSource(url, { withCredentials: true });
  source.onopen = () => onStatus('open');
  // EventSource reconnects on its own; we only surface the state
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return onStatus('connecting');
    onStatus('error');
    // the server refused the stream; a 409 tenant_changed is not visible here, so ask the session
    void confirmTenant().catch(() => {});
  };
  for (const type of PUSH_EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      const event = parsePushMessage(type, (message as MessageEvent<string>).data);
      if (event) onEvent(event);
    });
  }
  return { close: () => source.close() };
};

let connector: PushConnector = eventSourceConnector;

export function setPushConnector(next: PushConnector): void {
  connector = next;
}

export function connectPush(
  onEvent: (event: PushEvent) => void,
  onStatus: (status: PushStatus) => void = () => {},
): PushConnection {
  return connector(onEvent, onStatus);
}
