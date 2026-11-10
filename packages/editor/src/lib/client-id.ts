/**
 * P6-81: this tab's id. api/client.ts sends it as `push-ref` on every REST call, so the server tells two
 * tabs of one user apart (presence and the write lock). One random id per tab, kept in memory only: a
 * reload is a new client, as in n8n.
 */
let current: string | null = null;

function randomId(): string {
  const crypto = globalThis.crypto;
  // randomUUID needs a secure context; plain http on a LAN address has only getRandomValues
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** the same id for the life of this tab */
export function clientId(): string {
  current ??= randomId();
  return current;
}
