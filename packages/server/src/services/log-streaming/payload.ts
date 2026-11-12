/**
 * P6-06 (S5 C0 stub, L3 fills it): the message a destination sends for one event, as n8n's event message (`ts` an
 * ISO string), anonymized when the destination asks for it.
 */
import type { DataObject } from '@workflow/workflow';
import type { StreamEvent } from '../events/stream';

/** stub (L3) */
export function destinationMessage(
  _event: StreamEvent,
  _options: { anonymizeAuditMessages: boolean },
): DataObject {
  throw new Error('not implemented (L3)');
}
