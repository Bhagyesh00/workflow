/** P6-64 (L8): one destination on the log streaming page: label, type, last error, enable switch, edit, delete. */
import { Pencil, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LogDestination } from '../../api/types';
import { IconButton } from '../ui/Button';
import { Switch } from '../ui/Field';
import { Badge } from '../ui/misc';

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

export const DESTINATION_TYPE_NAMES = { webhook: 'Webhook', syslog: 'Syslog', sentry: 'Sentry' } as const;

/** where the destination sends to, without a path, query or key */
function targetOf(destination: LogDestination): string {
  try {
    if (destination.type === 'webhook') return new URL(destination.settings.url).host;
    if (destination.type === 'sentry') return new URL(destination.settings.dsn).host;
  } catch {
    return '';
  }
  const { host, port, protocol } = destination.settings;
  return `${host}:${port} over ${protocol.toUpperCase()}`;
}

function eventsSummary(events: string[]): string {
  if (events.length === 0) return 'No events selected: nothing is sent';
  if (events.includes('*')) return 'All events';
  return events.length === 1 ? '1 subscription' : `${events.length} subscriptions`;
}

export function DestinationCard({
  destination,
  onEdit,
  onToggle,
  onDelete,
  busy,
}: DestinationCardProps): ReactNode {
  const target = targetOf(destination);
  return (
    <li className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{destination.label}</span>
          <Badge tone="brand">{DESTINATION_TYPE_NAMES[destination.type]}</Badge>
          {!destination.enabled && <Badge>Off</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-ink-2">
          {[target, eventsSummary(destination.subscribedEvents)].filter(Boolean).join(' - ')}
        </p>
        {destination.lastError && (
          <p className="mt-1 text-sm text-err" role="status">
            {`Last send failed: ${destination.lastError}`}
          </p>
        )}
        {(destination.droppedEvents ?? 0) > 0 && (
          <p className="mt-1 text-sm text-warn">
            {`${destination.droppedEvents} events were dropped because the send queue was full.`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={destination.enabled}
          onChange={onToggle}
          label={`Enable ${destination.label}`}
          disabled={busy}
        />
        <IconButton label={`Edit ${destination.label}`} disabled={busy} onClick={onEdit}>
          <Pencil size={14} />
        </IconButton>
        <IconButton label={`Delete ${destination.label}`} disabled={busy} onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}
