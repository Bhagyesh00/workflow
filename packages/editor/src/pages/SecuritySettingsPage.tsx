/**
 * /settings/security (P3-19): admins turn workflow reviews on or off for the workspace
 * (settingsApi.update({ workflowReviews: { enabled } })).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import { settingsApi } from '../api/endpoints';
import { queryKeys, useMe, useSettings } from '../api/queries';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { forgetPublishChoice, hasRememberedChoice } from '../features/reviews/review-publish';
import { toast } from '../stores/ui-store';

export function SecuritySettingsPage() {
  const me = useMe();
  const settings = useSettings();
  const queryClient = useQueryClient();
  const [remembered, setRemembered] = useState(hasRememberedChoice());
  const enabled = settings.workflowReviews?.enabled === true;
  const isAdmin = me.data?.role === 'owner' || me.data?.role === 'admin';

  const update = useMutation({
    mutationFn: (next: boolean) => settingsApi.update({ workflowReviews: { enabled: next } }),
    onSuccess: async (_result, next) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success(next ? 'Workflow reviews are on' : 'Workflow reviews are off');
    },
    onError: (error) => toast.error('Could not change the setting', errorMessage(error)),
  });

  if (me.isLoading) return <PageLoader />;
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <h2 className="text-lg font-semibold">Security</h2>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4">
        <div className="min-w-0">
          <p id="reviews-label" className="font-semibold text-ink">
            Workflow reviews
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Editors submit a workflow version for review before it goes live. A reviewer approves it, which
            publishes it, or asks for changes. While a request is open, publishing is paused.
          </p>
        </div>
        <Switch
          label="Workflow reviews"
          checked={enabled}
          disabled={!isAdmin || update.isPending}
          onChange={(next) => update.mutate(next)}
        />
      </div>
      {!isAdmin && <Callout>Only admins can change this setting.</Callout>}
      {enabled && remembered && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm text-ink-2">This browser skips the Publish or Submit for review question.</p>
          <Button
            onClick={() => {
              forgetPublishChoice();
              setRemembered(false);
            }}
          >
            Ask again
          </Button>
        </div>
      )}
    </section>
  );
}
