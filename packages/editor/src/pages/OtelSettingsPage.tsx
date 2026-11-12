/**
 * P6-68 (L12): Settings > OpenTelemetry, at /settings/opentelemetry. Status and enable control, the
 * connection block (protocol, endpoint, path, service name, headers, timeout, Test), sampling and span
 * options, and an unsaved-changes dialog. Only for `otel:manage` (the settings link is gated on it; the server
 * is the lock); a member's visit fetches nothing.
 */
import type { ReactNode } from 'react';
import { useMe, useOtelSettings } from '../api/queries';
import { Callout, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';

export function OtelSettingsPage(): ReactNode {
  const me = useMe();
  const { can } = usePermissions();
  const allowed = can('otel:manage');
  useOtelSettings(allowed);

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage OpenTelemetry.</Callout>;
  // stub (L12): the settings form
  return null;
}
