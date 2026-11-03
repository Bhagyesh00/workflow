/**
 * jsdom gaps for React Flow and CodeMirror, plus an MSW server answering `/rest/*` with the
 * in-memory MockBackend (the same implementation the demo build uses).
 */
import { cleanup } from '@testing-library/react';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { fetchTransport, setTransport } from '../src/api/client';
import { setPushConnector } from '../src/api/push';
import { backend, resetBackend } from './backend';

class ResizeObserverStub {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 220, height: 64 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= ResizeObserverStub;

class DOMMatrixStub {
  m22: number;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? '');
    this.m22 = scale ? Number(scale[1]) : 1;
  }
}
g.DOMMatrixReadOnly ??= DOMMatrixStub;

if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  // CodeMirror measures text with ranges
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect;
  Range.prototype.getClientRects ??= () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  // React Flow reads element sizes
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get: () => 64 },
    offsetWidth: { configurable: true, get: () => 220 },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => rect as DOMRect;
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
}

export const server = setupServer(
  http.all(/\/rest\/.*/, async ({ request }) => {
    const url = new URL(request.url);
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    }
    const response = await backend().handle({
      method: request.method as 'GET',
      path: url.pathname.replace(/^\/rest/, ''),
      query: Object.fromEntries(url.searchParams),
      body,
    });
    return HttpResponse.json((response.body ?? null) as JsonBodyType, { status: response.status });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

beforeEach(() => {
  resetBackend();
  setTransport(fetchTransport);
  setPushConnector((onEvent, onStatus) => {
    onStatus('open');
    return { close: backend().subscribe(onEvent) };
  });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.localStorage?.clear?.();
});

afterAll(() => server.close());

// object URLs for binary previews (P3-08, P3-14); jsdom has none
if (typeof URL !== 'undefined') {
  let objectUrlSeq = 0;
  URL.createObjectURL ??= () => `blob:http://localhost/${++objectUrlSeq}`;
  URL.revokeObjectURL ??= () => undefined;
}
