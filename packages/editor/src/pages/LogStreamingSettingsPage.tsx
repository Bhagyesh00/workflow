/**
 * P6-64 (L8): Settings > Log streaming, at /settings/log-streaming (n8n's path). One card per destination
 * (webhook, syslog, Sentry) with an enable switch; "Add destination" asks for the type and opens
 * `DestinationModal` (Settings and Events tabs, Send test event, Delete). Only for `logStreaming:manage` (the
 * settings link is gated on it; the server is the lock); a member's visit fetches nothing.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Radio } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../api/client';
import { logStreamingApi } from '../api/endpoints';
import { queryKeys, useLogDestinations, useMe } from '../api/queries';
import type { LogDestination, LogDestinationType } from '../api/types';
import { DESTINATION_TYPE_NAMES, DestinationCard } from '../components/log-streaming/DestinationCard';
import { DestinationModal, saveBodyOf } from '../components/log-streaming/DestinationModal';
import { Button } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

const TYPE_HINTS: Record<LogDestinationType, string> = {
  webhook: 'Send each event to a web address, with optional headers and a credential.',
  syslog: 'Send each event to a syslog server over UDP, TCP or TLS.',
  sentry: 'Send each event to a Sentry project.',
};

interface ModalState {
  /** changes on every open, so the modal starts from fresh fields */
  key: number;
  type: LogDestinationType;
  destination: LogDestination | null;
}

export function LogStreamingSettingsPage(): ReactNode {
  const me = useMe();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const allowed = can('logStreaming:manage');
  const destinations = useLogDestinations(allowed);
  const [picking, setPicking] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [opened, setOpened] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.logStreaming });

  const toggle = useMutation({
    mutationFn: ({ destination, enabled }: { destination: LogDestination; enabled: boolean }) =>
      logStreamingApi.save(saveBodyOf(destination, { enabled })),
    onMutate: ({ destination }) => setBusyId(destination.id),
    onSuccess: refresh,
    onError: (error) => toast.error('Could not save the destination', errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const remove = useMutation({
    mutationFn: (destination: LogDestination) => logStreamingApi.remove(destination.id),
    onMutate: (destination) => setBusyId(destination.id),
    onSuccess: async () => {
      toast.success('Destination deleted');
      await refresh();
    },
    onError: (error) => toast.error('Could not delete the destination', errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const open = (type: LogDestinationType, destination: LogDestination | null) => {
    setOpened((n) => n + 1);
    setModal({ key: opened + 1, type, destination });
  };

  const askDelete = async (destination: LogDestination) => {
    const ok = await confirmDialog({
      title: `Delete ${destination.label}?`,
      description: 'The destination stops receiving events and its queue is dropped. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(destination);
  };

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage log streaming.</Callout>;

  const list = destinations.data ?? [];
  return (
    <>
      <Panel
        title="Log streaming"
        description="Send the events of this workspace to your own systems: run and node events, AI events and audit events. Each destination picks the events it receives."
        action={
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setPicking(true)}>
            Add destination
          </Button>
        }
      >
        {destinations.isLoading ? (
          <PageLoader label="Loading destinations" />
        ) : destinations.error ? (
          <div className="px-5 py-4">
            <Callout tone="err">{errorMessage(destinations.error)}</Callout>
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Radio size={20} />}
            title="No destinations yet"
            description="Add a webhook, a syslog server or Sentry to start streaming events."
          />
        ) : (
          <ul>
            {list.map((destination) => (
              <DestinationCard
                key={destination.id}
                destination={destination}
                busy={busyId === destination.id}
                onEdit={() => open(destination.type, destination)}
                onToggle={(enabled) => toggle.mutate({ destination, enabled })}
                onDelete={() => void askDelete(destination)}
              />
            ))}
          </ul>
        )}
      </Panel>
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        size="sm"
        title="Add destination"
        description="Where should the events go?"
      >
        <div className="flex flex-col gap-2">
          {(Object.keys(DESTINATION_TYPE_NAMES) as LogDestinationType[]).map((type) => (
            <button
              key={type}
              type="button"
              aria-label={DESTINATION_TYPE_NAMES[type]}
              onClick={() => {
                setPicking(false);
                open(type, null);
              }}
              className="rounded-lg border border-line px-3 py-2 text-left hover:border-line-strong hover:bg-surface-2"
            >
              <span className="block text-sm font-semibold text-ink">{DESTINATION_TYPE_NAMES[type]}</span>
              <span className="block text-xs text-ink-2">{TYPE_HINTS[type]}</span>
            </button>
          ))}
        </div>
      </Dialog>
      {modal && (
        <DestinationModal
          key={modal.key}
          open
          type={modal.type}
          destination={modal.destination}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
