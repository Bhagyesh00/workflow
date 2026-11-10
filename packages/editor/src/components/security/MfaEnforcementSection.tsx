/**
 * P6-18: Settings > Security, two-step sign-in for everyone (`user:enforceMfa`); refused until the
 * caller's own MFA is on. Gates itself.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { mfaApi } from '../../api/endpoints';
import { queryKeys, useMe, useSettings } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { confirmDialog } from '../ui/Dialog';
import { Switch } from '../ui/Field';
import { Callout } from '../ui/misc';

export function MfaEnforcementSection() {
  const { can } = usePermissions();
  const me = useMe().data;
  const settings = useSettings();
  const queryClient = useQueryClient();
  const enforced = settings.mfa?.enforced === true;
  const enforce = useMutation({
    mutationFn: (next: boolean) => mfaApi.enforce(next),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success(
        result.enforced
          ? 'Two-step sign-in is required for everyone'
          : 'Two-step sign-in is no longer required',
      );
    },
    onError: (error) => toast.error('Could not change the setting', errorMessage(error)),
  });

  if (!can('user:enforceMfa')) {
    return <Callout>Only admins can require two-step sign-in.</Callout>;
  }
  if (settings.features.mfa === false) {
    return <Callout>Two-step sign-in is turned off on this server.</Callout>;
  }
  const ownMfa = me?.mfaEnabled === true;

  const change = async (next: boolean) => {
    if (next) {
      const ok = await confirmDialog({
        title: 'Require two-step sign-in for everyone?',
        description:
          'Everyone in this workspace who has not set it up is asked to do so on their next request, and can do nothing else until they have.',
        confirmLabel: 'Require',
        tone: 'primary',
      });
      if (!ok) return;
    }
    enforce.mutate(next);
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="min-w-0">
        <p className="font-semibold text-ink">Require two-step sign-in</p>
        <p className="mt-1 text-sm text-ink-2">
          Everyone in this workspace signs in with a code from an authenticator app. People who signed in with
          single sign-on are not asked again.
        </p>
        {!ownMfa && !enforced && (
          <p className="mt-1 text-sm text-ink-2" data-testid="mfa-enforce-hint">
            Turn on two-step sign-in for your own account first, under{' '}
            <Link to="/settings/account" className="font-semibold text-brand hover:underline">
              Your account
            </Link>
            .
          </p>
        )}
      </div>
      <Switch
        label="Require two-step sign-in"
        checked={enforced}
        disabled={enforce.isPending || (!ownMfa && !enforced)}
        onChange={(next) => void change(next)}
      />
    </div>
  );
}
