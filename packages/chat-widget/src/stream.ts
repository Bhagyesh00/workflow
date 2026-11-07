import { parseReply } from './api';
import { ERROR_MESSAGES } from './i18n';

/** What the stream parser tells the widget; one open bot message per key. */
export interface StreamHandlers {
  open(key: string): void;
  append(key: string, text: string): void;
  close(key: string): void;
  error(text: string): void;
  /** a `wait` frame; the caller decides whether `resumeUrl` is allowed */
  wait(resumeUrl: string): void;
}

const PLAIN_KEY = 'plain-text';

function frameKey(frame: Record<string, unknown>): string {
  const meta = frame.metadata;
  if (meta && typeof meta === 'object') {
    const { nodeId, runIndex } = meta as { nodeId?: unknown; runIndex?: unknown };
    return `${String(nodeId ?? '')}:${String(runIndex ?? 0)}`;
  }
  return 'default:0';
}

function itemText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === undefined) return undefined;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function looksLikeHtmlLine(line: string): boolean {
  return /^\s*<(!doctype html|html[\s>])/i.test(line);
}

/**
 * Reads a newline-delimited JSON reply. Lines can be split across reads, so the tail is kept until the
 * next chunk. A line that is not JSON counts as text; a web page from a proxy becomes one error text;
 * the end of the stream closes every message still open.
 */
export async function readStream(response: Response, handlers: StreamHandlers): Promise<void> {
  const open = new Set<string>();
  let plainHasText = false;
  let stopped = false;

  const openKey = (key: string) => {
    if (open.has(key)) return;
    open.add(key);
    handlers.open(key);
  };
  const closeKey = (key: string) => {
    if (!open.delete(key)) return;
    handlers.close(key);
  };

  const handleLine = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    if (looksLikeHtmlLine(line)) {
      stopped = true;
      handlers.error(ERROR_MESSAGES.htmlReply);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      appendPlain(line);
      return;
    }
    const frame = parsed as Record<string, unknown>;
    switch (frame.type) {
      case 'begin':
        openKey(frameKey(frame));
        return;
      case 'item': {
        const text = itemText(frame.content);
        if (text === undefined) return;
        const key = frameKey(frame);
        openKey(key);
        handlers.append(key, text);
        return;
      }
      case 'end':
        closeKey(frameKey(frame));
        return;
      case 'error': {
        closeKey(frameKey(frame));
        const content = typeof frame.content === 'string' && frame.content ? frame.content : undefined;
        const message = typeof frame.message === 'string' && frame.message ? frame.message : undefined;
        handlers.error(content ?? message ?? ERROR_MESSAGES.failed);
        return;
      }
      case 'wait':
        if (typeof frame.resumeUrl === 'string') handlers.wait(frame.resumeUrl);
        return;
      default: {
        // a whole reply object on one line: show its text
        const reply = parseReply(line, 'application/json');
        if (reply.kind === 'text' && reply.text) appendPlain(reply.text);
      }
    }
  };

  function appendPlain(text: string): void {
    openKey(PLAIN_KEY);
    handlers.append(PLAIN_KEY, plainHasText ? `\n${text}` : text);
    plainHasText = true;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    handlers.error(ERROR_MESSAGES.htmlReply);
    return;
  }

  try {
    const body = response.body;
    if (!body) {
      for (const line of (await response.text()).split('\n')) {
        if (stopped) break;
        handleLine(line);
      }
    } else {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0 && !stopped) {
            handleLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (!stopped && buffer) handleLine(buffer);
      } finally {
        if (stopped) await reader.cancel().catch(() => undefined);
        else reader.releaseLock();
      }
    }
  } finally {
    // a stream that stopped after `item` leaves no open message
    for (const key of [...open]) closeKey(key);
  }
}
