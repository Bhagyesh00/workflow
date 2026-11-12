/**
 * P6-64 (L8): the Events tab: a checkbox tree grouped by `eventGroupOf` (a whole group saves its prefix, a
 * single event its name; `*` is everything), with the anonymize switch in the audit group.
 */
import type { ReactNode } from 'react';

export interface EventTreeProps {
  /** every event name a destination may subscribe to (`useEventNames`, else workflow's `EVENT_CATALOG`) */
  eventNames: string[];
  /** the destination's `subscribedEvents` (group prefixes, single names or `*`) */
  value: string[];
  onChange(next: string[]): void;
  anonymizeAuditMessages: boolean;
  onAnonymizeChange(next: boolean): void;
  disabled?: boolean;
}

// stub (L8)
export function EventTree(_props: EventTreeProps): ReactNode {
  return null;
}
