/**
 * P6-64 (L8): add or edit one destination. Tabs Settings (label, the type's fields, circuit breaker) and Events
 * (`EventTree`, anonymize); Save, Send test event with the result, Delete with a confirm. Saved secrets show
 * blank with a "saved" hint; a blank keeps the saved value.
 */
import type { ReactNode } from 'react';
import type { LogDestination, LogDestinationType } from '../../api/types';

export interface DestinationModalProps {
  open: boolean;
  /** the type picked in "Add destination", or the edited destination's type */
  type: LogDestinationType;
  /** null for a new destination */
  destination: LogDestination | null;
  onClose(): void;
  /** after a save; the page refreshes its list */
  onSaved?(destination: LogDestination): void;
}

// stub (L8)
export function DestinationModal(_props: DestinationModalProps): ReactNode {
  return null;
}
