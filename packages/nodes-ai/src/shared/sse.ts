/** Server-Sent Events parsing (model streaming and MCP Streamable HTTP responses). */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse a complete SSE body into events (comments and retry fields are ignored). */
export function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  const flush = () => {
    if (data.length) events.push({ event: event || 'message', data: data.join('\n'), id });
    event = '';
    data = [];
    id = undefined;
  };
  for (const raw of body.split(/\r\n|\r|\n/)) {
    if (raw === '') {
      flush();
      continue;
    }
    if (raw.startsWith(':')) continue;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  flush();
  return events;
}

/** JSON payloads of the events, skipping `[DONE]` sentinels and unparsable data. */
export function sseJson(body: string): Array<{ event: string; json: any }> {
  const out: Array<{ event: string; json: any }> = [];
  for (const e of parseSse(body)) {
    if (e.data === '[DONE]') continue;
    try {
      out.push({ event: e.event, json: JSON.parse(e.data) });
    } catch {
      /* not JSON: ignore */
    }
  }
  return out;
}
