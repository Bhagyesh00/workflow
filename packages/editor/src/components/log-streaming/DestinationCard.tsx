/** P6-64 (L8): one destination on the log streaming page: label, type, last error, enable switch, edit, delete. */
import type { ReactNode } from 'react';
import type { LogDestination } from '../../api/types';

export interface DestinationCardProps {
  destination: LogDestination;
  /** opens `DestinationModal` for this destination */
  onEdit(): void;
  /** saves `enabled` (`eventBusDestination:update`) */
  onToggle(enabled: boolean): void;
  /** asks to confirm, then deletes (`eventBusDestination:delete`) */
  onDelete(): void;
  /** a save or delete of this destination is running */
  busy?: boolean;
}

// stub (L8)
export function DestinationCard(_props: DestinationCardProps): ReactNode {
  return null;
}
