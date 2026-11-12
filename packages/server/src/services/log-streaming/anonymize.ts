/**
 * P6-06 (S5 L3): a destination's `anonymizeAuditMessages`, as n8n: in an `audit.*` event every string under a
 * `_`-prefixed key becomes `*`; other groups are untouched.
 */
import { type DataObject, eventGroupOf } from '@workflow/workflow';

function maskStrings(value: unknown): unknown {
  if (typeof value === 'string') return '*';
  if (Array.isArray(value)) return value.map(maskStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskStrings(inner)]));
  }
  return value;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key.startsWith('_') ? maskStrings(inner) : walk(inner),
      ]),
    );
  }
  return value;
}

/** a copy of `payload` with the strings under `_` keys masked; the input is never changed */
export function anonymizeAuditPayload(eventName: string, payload: DataObject): DataObject {
  if (eventGroupOf(eventName) !== 'audit') return payload;
  return walk(payload) as DataObject;
}
