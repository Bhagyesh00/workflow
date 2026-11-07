/** The session id lives in memory only: no localStorage, no cookie (the hosted page runs in a sandbox). */

const FRAGMENT_KEY = 'sessionId';

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

export function readFragmentSession(hash: string): string | undefined {
  const value = fragmentParams(hash).get(FRAGMENT_KEY);
  return value?.trim() ? value : undefined;
}

export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Write `#sessionId=...` with `history.replaceState` (no history entry). A page that forbids it keeps working. */
export function writeFragmentSession(id: string): void {
  try {
    const params = fragmentParams(window.location.hash);
    params.set(FRAGMENT_KEY, id);
    const url = `${window.location.pathname}${window.location.search}#${params.toString()}`;
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // opaque origin or a frozen history: the id stays in memory
  }
}

/** Session id order: the option, the URL fragment, a new uuid. The chosen id is written to the fragment. */
export function resolveSessionId(option: string | undefined): string {
  let id: string | undefined = option?.trim() ? option : undefined;
  if (!id) {
    try {
      id = readFragmentSession(window.location.hash);
    } catch {
      id = undefined;
    }
  }
  const resolved = id ?? newSessionId();
  writeFragmentSession(resolved);
  return resolved;
}
