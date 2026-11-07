import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatInstance, createChat } from '../src/index';
import { readStream, type StreamHandlers } from '../src/stream';

const WEBHOOK = 'http://localhost:3000/webhook/abc/chat';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function ndjson(chunks: (string | Uint8Array)[], contentType = 'application/x-ndjson'): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

const meta = (nodeId: string, runIndex = 0) => ({
  nodeId,
  nodeName: nodeId,
  runIndex,
  itemIndex: 0,
  timestamp: 1,
});
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;

function recorder() {
  const log: string[] = [];
  const handlers: StreamHandlers = {
    open: (key) => log.push(`open:${key}`),
    append: (key, text) => log.push(`append:${key}:${text}`),
    close: (key) => log.push(`close:${key}`),
    error: (text) => log.push(`error:${text}`),
    wait: (url) => log.push(`wait:${url}`),
  };
  return { log, handlers };
}

describe('NDJSON parser', () => {
  it('reads begin, item and end frames', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'item', content: 'Hel', metadata: meta('a') }),
        frame({ type: 'item', content: 'lo', metadata: meta('a') }),
        frame({ type: 'end', metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toEqual(['open:a:0', 'append:a:0:Hel', 'append:a:0:lo', 'close:a:0']);
  });

  it('keeps a line that is split across reads, in the middle of a frame and of a character', async () => {
    const { log, handlers } = recorder();
    const full = new TextEncoder().encode(frame({ type: 'item', content: 'café ok', metadata: meta('a') }));
    const cut = full.indexOf(0xc3) + 1; // between the two bytes of the e-acute
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }).slice(0, 12),
        frame({ type: 'begin', metadata: meta('a') }).slice(12),
        full.slice(0, 20),
        full.slice(20, cut),
        full.slice(cut),
        frame({ type: 'end', metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toEqual(['open:a:0', 'append:a:0:café ok', 'close:a:0']);
  });

  it('handles the last line without a newline', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        JSON.stringify({ type: 'end', metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toEqual(['open:a:0', 'close:a:0']);
  });

  it('counts a line that is not JSON as text', async () => {
    const { log, handlers } = recorder();
    await readStream(ndjson(['just words\n', 'more words\n']), handlers);
    expect(log).toEqual([
      'open:plain-text',
      'append:plain-text:just words',
      'append:plain-text:\nmore words',
      'close:plain-text',
    ]);
  });

  it('turns an HTML proxy error into one error text', async () => {
    const { log, handlers } = recorder();
    await readStream(ndjson(['<!DOCTYPE html>\n<html><body>502 Bad Gateway</body></html>\n']), handlers);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^error:/);
    const { log: log2, handlers: handlers2 } = recorder();
    await readStream(ndjson(['<html>x</html>\n'], 'text/html'), handlers2);
    expect(log2).toHaveLength(1);
    expect(log2[0]).toMatch(/^error:/);
  });

  it('makes one message per node and run: two nodes, two messages', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'begin', metadata: meta('b') }),
        frame({ type: 'item', content: 'A1', metadata: meta('a') }),
        frame({ type: 'item', content: 'B1', metadata: meta('b') }),
        frame({ type: 'end', metadata: meta('a') }),
        frame({ type: 'end', metadata: meta('b') }),
        frame({ type: 'begin', metadata: meta('a', 1) }),
        frame({ type: 'item', content: 'A2', metadata: meta('a', 1) }),
        frame({ type: 'end', metadata: meta('a', 1) }),
      ]),
      handlers,
    );
    expect(log.filter((l) => l.startsWith('open:'))).toEqual(['open:a:0', 'open:b:0', 'open:a:1']);
    expect(log).toContain('append:b:0:B1');
    expect(log).toContain('append:a:1:A2');
  });

  it('opens a message for an item that arrives without begin', async () => {
    const { log, handlers } = recorder();
    await readStream(ndjson([frame({ type: 'item', content: 'x', metadata: meta('a') })]), handlers);
    expect(log).toEqual(['open:a:0', 'append:a:0:x', 'close:a:0']);
  });

  it('stringifies an item that is not a string', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'item', content: { k: 1 }, metadata: meta('a') }),
        frame({ type: 'item', content: 42, metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toContain('append:a:0:{"k":1}');
    expect(log).toContain('append:a:0:42');
  });

  it('reads an error frame from content, then message', async () => {
    const first = recorder();
    await readStream(
      ndjson([frame({ type: 'error', content: 'from content', message: 'from message' })]),
      first.handlers,
    );
    expect(first.log).toEqual(['error:from content']);
    const second = recorder();
    await readStream(
      ndjson([frame({ type: 'error', content: '', message: 'from message' })]),
      second.handlers,
    );
    expect(second.log).toEqual(['error:from message']);
  });

  it('closes the open message of a node whose error frame arrives', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'error', content: 'boom', message: 'boom', metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toEqual(['open:a:0', 'close:a:0', 'error:boom']);
  });

  it('passes a wait frame to the caller', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([frame({ type: 'wait', resumeUrl: 'http://localhost:3000/webhook-waiting/1' })]),
      handlers,
    );
    expect(log).toEqual(['wait:http://localhost:3000/webhook-waiting/1']);
  });

  it('a stream that stops after item leaves no open message', async () => {
    const { log, handlers } = recorder();
    await readStream(
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'item', content: 'half', metadata: meta('a') }),
      ]),
      handlers,
    );
    expect(log).toEqual(['open:a:0', 'append:a:0:half', 'close:a:0']);
  });

  it('closes open messages when the connection drops', async () => {
    const { log, handlers } = recorder();
    const enc = new TextEncoder();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('reset'));
          return;
        }
        sent = true;
        controller.enqueue(enc.encode(frame({ type: 'begin', metadata: meta('a') })));
      },
    });
    const response = new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    await expect(readStream(response, handlers)).rejects.toThrow('reset');
    expect(log).toEqual(['open:a:0', 'close:a:0']);
  });
});

describe('streamed reply in the page', () => {
  let chat: ChatInstance | undefined;
  afterEach(() => {
    chat?.unmount();
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  });

  it('shows two nodes as two bot messages and a cut stream as a finished message', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const fetchFake = vi.fn(async () =>
      ndjson([
        frame({ type: 'begin', metadata: meta('a') }),
        frame({ type: 'item', content: 'First **node**', metadata: meta('a') }),
        frame({ type: 'end', metadata: meta('a') }),
        frame({ type: 'begin', metadata: meta('b') }),
        frame({ type: 'item', content: 'Second', metadata: meta('b') }),
      ]),
    );
    chat = createChat({
      webhookUrl: WEBHOOK,
      target,
      mode: 'fullscreen',
      loadPreviousSession: false,
      enableStreaming: true,
      fetch: fetchFake as unknown as typeof fetch,
    });
    const area = target.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'go';
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();
    const bots = target.querySelectorAll('.chat-message-from-bot:not(.chat-message-typing)');
    expect(bots).toHaveLength(2);
    expect(bots[0]?.querySelector('strong')?.textContent).toBe('node');
    expect(bots[1]?.textContent).toBe('Second');
    expect((target.querySelector('.chat-message-typing') as HTMLElement).hidden).toBe(true);
    expect(area.disabled).toBe(false);
  });
});
