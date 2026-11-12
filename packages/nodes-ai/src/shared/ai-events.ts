/**
 * P6-59: the 14 `ai.*` log events. A node hands its event to `ctx.logAiEvent`; the engine passes it to the run's
 * lifecycle observers and the server decides who gets the `msg`. The helper here builds `msg` as n8n does: the
 * JSON text of the data. It never throws: an event must not fail a node.
 */
import { type AiEventName, redactSecrets } from '@workflow/workflow';

/** a context that can report an AI event (optional: tests and older contexts have none) */
export interface AiEventSource {
  logAiEvent?(name: AiEventName, msg?: string): void;
}

/** keys whose value is a credential, compared in lower case */
const CREDENTIAL_KEYS = new Set([
  'apikey',
  'token',
  'accesstoken',
  'password',
  'secret',
  'authorization',
  'credentials',
]);

const MAX_DEPTH = 8;

/**
 * Removes credential-shaped keys (`apiKey`, `token`, `accessToken`, `password`, `secret`, `authorization`,
 * `credentials`, any case) and every string value that `redactSecrets` changes, at any depth. The input is not
 * changed. Used on the `ai.tool.called` data, whose arguments come from the model.
 */
export function stripCredentialValues(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value) === value ? value : undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripCredentialValues(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) continue;
    const kept = stripCredentialValues(entry, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** JSON text that survives cycles, bigints and errors */
function stringify(data: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(data, (_key, value: unknown) => {
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Error) return { name: value.name, message: value.message };
        if (value !== null && typeof value === 'object') {
          if (seen.has(value)) return '[circular]';
          seen.add(value);
        }
        return value;
      }) ?? ''
    );
  } catch {
    return '';
  }
}

const MAX_ERROR_TEXT = 1000;

/** an error's message for an event: secrets removed, 1000 characters at most, no stack */
export function eventErrorText(error: unknown): string {
  const text = redactSecrets(error instanceof Error ? error.message : String(error));
  return text.length > MAX_ERROR_TEXT ? text.slice(0, MAX_ERROR_TEXT) : text;
}

/** `ai.embeddings.embedded.document` for a document batch, `ai.embeddings.embedded.query` for one query text */
export function logEmbeddingEvent(ctx: AiEventSource, purpose: 'document' | 'query', texts: string[]): void {
  if (purpose === 'query') logAiEvent(ctx, 'ai.embeddings.embedded.query', { query: texts[0] });
  else logAiEvent(ctx, 'ai.embeddings.embedded.document', { documents: texts });
}

/** Reports one AI event; `data` becomes the event's `msg` (credentials removed first for `ai.tool.called`). */
export function logAiEvent(ctx: AiEventSource, name: AiEventName, data: unknown): void {
  try {
    if (typeof ctx.logAiEvent !== 'function') return;
    ctx.logAiEvent(name, stringify(name === 'ai.tool.called' ? stripCredentialValues(data) : data));
  } catch {
    // an event never fails the node that reports it
  }
}
