/**
 * P6-02: Settings > Authentication > SCIM: enable (needs SSO), base URL, token mint, rotate and revoke,
 * deprovisioning policy and transfer target. n8n has no screen for SCIM; this one is ours, so an admin can
 * set it up without the REST routes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { scimApi, ssoApi } from '../api/endpoints';
import { queryKeys, useMe } from '../api/queries';
import type { ScimConfig } from '../api/types';
import { Button, IconButton } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { FormField, Select, Switch } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

/** the select's value for "no project picked": the owner's personal project takes the work */
const OWNER_HOME = '';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={label}
      size="sm"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </IconButton>
  );
}

export function ScimSettingsPage() {
  const { can } = usePermissions();
  const me = useMe();
  const queryClient = useQueryClient();
  const allowed = can('scim:manage');
  const config = useQuery({ queryKey: queryKeys.scimConfig, queryFn: scimApi.config, enabled: allowed });
  const targets = useQuery({
    queryKey: queryKeys.scimTransferTargets,
    queryFn: scimApi.transferTargets,
    enabled: allowed,
  });
  // the sign-in method decides whether SCIM can be turned on; when it can't be read, the server decides
  const sso = useQuery({ queryKey: queryKeys.ssoMethod, queryFn: ssoApi.method, enabled: allowed, retry: false });
  const [created, setCreated] = useState<string | null>(null);
  const [onDelete, setOnDelete] = useState<ScimConfig['onDelete']>('disable');
  const [dataAction, setDataAction] = useState<ScimConfig['dataAction']>('transfer');
  const [transferProjectId, setTransferProjectId] = useState(OWNER_HOME);

  useEffect(() => {
    if (!config.data) return;
    setOnDelete(config.data.onDelete);
    setDataAction(config.data.dataAction);
    setTransferProjectId(config.data.transferProjectId ?? OWNER_HOME);
  }, [config.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['scim'] });
  const enable = useMutation({
    mutationFn: (enabled: boolean) => scimApi.setEnabled(enabled),
    onSuccess: async (result) => {
      await refresh();
      toast.success(result.enabled ? 'SCIM provisioning is on' : 'SCIM provisioning is off');
    },
    onError: (error) => toast.error('Could not change SCIM provisioning', errorMessage(error)),
  });
  const savePolicy = useMutation({
    mutationFn: () =>
      scimApi.setDeprovisioning({
        onDelete,
        dataAction,
        transferProjectId: dataAction === 'transfer' && transferProjectId ? transferProjectId : null,
      }),
    onSuccess: async () => {
      await refresh();
      toast.success('Removal settings saved');
    },
    onError: (error) => toast.error('Could not save the removal settings', errorMessage(error)),
  });
  const mint = useMutation({
    mutationFn: scimApi.createToken,
    onSuccess: async (result) => {
      setCreated(result.token);
      await refresh();
    },
    onError: (error) => toast.error('Could not create the token', errorMessage(error)),
  });

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage SCIM provisioning.</Callout>;
  if (config.isLoading) return <PageLoader />;
  if (config.error || !config.data) {
    return (
      <Callout tone="err">{config.error ? errorMessage(config.error) : 'Could not load the SCIM settings.'}</Callout>
    );
  }
  const data = config.data;
  const method = sso.data?.method;
  // known to be off: email or LDAP sign-in
  const ssoOff = method !== undefined && method !== 'saml' && method !== 'oidc';

  const rotate = async () => {
    if (data.hasToken) {
      const ok = await confirmDialog({
        title: 'Create a new token?',
        description: 'The current token stops working right away. Put the new one into your identity provider.',
        confirmLabel: 'Create new token',
        tone: 'danger',
      });
      if (!ok) return;
    }
    mint.mutate();
  };
  const revoke = async () => {
    const ok = await confirmDialog({
      title: 'Revoke the token?',
      description: 'Your identity provider can no longer reach this workspace until you create a new token.',
      confirmLabel: 'Revoke token',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await scimApi.revokeToken();
      await refresh();
      toast.success('Token revoked');
    } catch (error) {
      toast.error('Could not revoke the token', errorMessage(error));
    }
  };

  const dirty =
    onDelete !== data.onDelete ||
    dataAction !== data.dataAction ||
    (dataAction === 'transfer' && transferProjectId !== (data.transferProjectId ?? OWNER_HOME));

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="SCIM provisioning"
        description="Your identity provider creates, updates and removes members of this workspace."
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Enable SCIM provisioning</p>
            {ssoOff && !data.enabled ? (
              <p className="mt-1 text-sm text-ink-2" data-testid="scim-sso-hint">
                Turn on SAML or OIDC single sign-on first. SCIM needs one of them.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">
                Turning single sign-on off turns this off too. The token stays.
              </p>
            )}
          </div>
          <Switch
            label="Enable SCIM provisioning"
            checked={data.enabled}
            disabled={enable.isPending || (ssoOff && !data.enabled)}
            onChange={(next) => enable.mutate(next)}
          />
        </div>

        <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
          <FormField label="SCIM base URL" hint="Put this in your identity provider as the SCIM connector base URL.">
            {(id) => (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  readOnly
                  value={data.baseUrl}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm"
                />
                <CopyButton text={data.baseUrl} label="Copy base URL" />
              </div>
            )}
          </FormField>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Token</p>
              <p className="text-sm text-ink-2" data-testid="scim-token-state">
                {data.hasToken ? (
                  <>
                    Token ending in <code>{data.tokenHint}</code>. It is not shown again.
                  </>
                ) : (
                  'No token yet. Create one to connect your identity provider.'
                )}
              </p>
            </div>
            <Button
              variant={data.hasToken ? 'secondary' : 'primary'}
              icon={<KeyRound size={15} />}
              loading={mint.isPending}
              onClick={() => void rotate()}
            >
              {data.hasToken ? 'Rotate token' : 'Create token'}
            </Button>
            {data.hasToken && (
              <Button variant="danger" onClick={() => void revoke()}>
                Revoke token
              </Button>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="When a member is removed"
        description="What happens when your identity provider deletes a member."
      >
        <form
          className="flex flex-col gap-4 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            savePolicy.mutate();
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold text-ink">Member</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="scim-on-delete"
                checked={onDelete === 'disable'}
                onChange={() => setOnDelete('disable')}
                className="mt-0.5 accent-[var(--wf-brand)]"
              />
              <span>
                Deactivate the member
                <span className="block text-ink-2">They cannot sign in. Their work stays where it is.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="scim-on-delete"
                checked={onDelete === 'delete'}
                onChange={() => setOnDelete('delete')}
                className="mt-0.5 accent-[var(--wf-brand)]"
              />
              <span>
                Remove the member
                <span className="block text-ink-2">
                  They leave the workspace. Admins are only deactivated, and owners are never touched.
                </span>
              </span>
            </label>
          </fieldset>

          {onDelete === 'delete' && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold text-ink">Their work</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scim-data-action"
                  checked={dataAction === 'transfer'}
                  onChange={() => setDataAction('transfer')}
                  className="mt-0.5 accent-[var(--wf-brand)]"
                />
                <span>Move it to a project</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scim-data-action"
                  checked={dataAction === 'delete'}
                  onChange={() => setDataAction('delete')}
                  className="mt-0.5 accent-[var(--wf-brand)]"
                />
                <span>Delete it</span>
              </label>
              {dataAction === 'transfer' && (
                <FormField
                  label="Move work to"
                  hint="With no project picked, or when the project is gone, the owner's personal project takes it."
                >
                  {(id) => (
                    <Select id={id} value={transferProjectId} onChange={(e) => setTransferProjectId(e.target.value)}>
                      <option value={OWNER_HOME}>The owner's personal project</option>
                      {(targets.data ?? []).map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                          {target.type === 'personal' ? ' (personal)' : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
              )}
            </fieldset>
          )}

          <div>
            <Button type="submit" variant="primary" loading={savePolicy.isPending} disabled={!dirty}>
              Save
            </Button>
          </div>
        </form>
      </Panel>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Copy your SCIM token"
        description="This is the only time the token is shown. Put it into your identity provider now."
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I copied it
          </Button>
        }
      >
        {created && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 break-all text-xs" data-testid="new-scim-token">
              {created}
            </code>
            <CopyButton text={created} label="Copy token" />
          </div>
        )}
      </Dialog>
    </div>
  );
}
