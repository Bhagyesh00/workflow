/**
 * P6-64 (L8): Settings > Log streaming, at /settings/log-streaming (n8n's path). One card per destination
 * (webhook, syslog, Sentry) with an enable switch; "Add destination" asks for the type and opens
 * `DestinationModal` (Settings and Events tabs, Send test event, Delete). Only for `logStreaming:manage` (the
 * settings link is gated on it; the server is the lock); a member's visit fetches nothing.
 */
import type { ReactNode } from 'react';
import { useLogDestinations, useMe } from '../api/queries';
import { Callout, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';

export function LogStreamingSettingsPage(): ReactNode {
  const me = useMe();
  const { can } = usePermissions();
  const allowed = can('logStreaming:manage');
  useLogDestinations(allowed);

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage log streaming.</Callout>;
  // stub (L8): the destination cards, "Add destination" and the modal
  return null;
}
