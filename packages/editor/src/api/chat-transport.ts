/**
 * P5-59: the `fetch` the canvas chat widget uses (`createChat({ fetch: chatFetch })`). The real
 * editor keeps the browser's fetch; the demo build swaps in a fake that answers the test chat URL
 * (`setChatFetch(demoChatFetch(backend))` in demo/install.ts). The widget sets
 * `credentials: 'omit'` on top of whatever this returns.
 */

const browserFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, init);

let current: typeof fetch = browserFetch;

/** Stable function: it always calls the fetch set last, so a widget mounted earlier sees a swap. */
export const chatFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => current(input, init);

/** Replace the chat fetch; `null` goes back to the browser's fetch. */
export function setChatFetch(fn: typeof fetch | null): void {
  current = fn ?? browserFetch;
}
