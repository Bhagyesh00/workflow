/**
 * P6-06 (S5 L3): the message a destination sends for one event, as n8n's event message (`ts` an ISO string),
 * anonymized when the destination asks for it.
 */
import type { DataObject } from '@workflow/workflow';
import type { StreamEvent } from '../events/stream';
import { anonymizeAuditPayload } from './anonymize';

export function destinationMessage(
  event: StreamEvent,
  options: { anonymizeAuditMessages: boolean },
): DataObject {
  const payload = options.anonymizeAuditMessages
    ? anonymizeAuditPayload(event.eventName, event.payload)
    : event.payload;
  return {
    __type: '$$EventMessage',
    id: event.id,
    ts: new Date(event.ts).toISOString(),
    eventName: event.eventName,
    message: event.message,
    payload,
  };
}
