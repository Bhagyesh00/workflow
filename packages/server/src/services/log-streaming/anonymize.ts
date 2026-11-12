/**
 * P6-06 (S5 C0 stub, L3 fills it): a destination's `anonymizeAuditMessages`, as n8n: in an `audit.*` event every
 * string under a `_`-prefixed key becomes `*`; other groups are untouched.
 */
import type { DataObject } from '@workflow/workflow';

/** stub (L3): a copy of `payload` with the `_` keys masked; the input is never changed */
export function anonymizeAuditPayload(_eventName: string, _payload: DataObject): DataObject {
  throw new Error('not implemented (L3)');
}
