/**
 * P6-13: Settings > Authentication > SSO: protocol select, SAML and OIDC forms, copy fields, test, toggle,
 * confirm before enabling. The saved secret never comes back (the OIDC form leaves it blank and a blank on
 * save keeps it); one method is on at a time, and moving from one to the other goes through email.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { ssoApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { OidcConfigBody, SamlConfigBody, SsoMethod } from '../../api/types';
import { OidcForm } from '../../components/sso/OidcForm';
import { SamlForm } from '../../components/sso/SamlForm';
import { confirmDialog } from '../../components/ui/Dialog';
import { Select, Switch } from '../../components/ui/Field';
import { Badge, Callout, PageLoader } from '../../components/ui/misc';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Panel } from '../settings/Panel';

type Protocol = 'saml' | 'oidc';

const NAMES: Record<Protocol, string> = { saml: 'SAML', oidc: 'OpenID Connect' };
const SHORT: Record<Protocol, string> = { saml: 'SAML', oidc: 'OIDC' };

function openTest(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function SsoSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canSaml = can('saml:manage');
  const canOidc = can('oidc:manage');
  const method = useQuery({
    queryKey: queryKeys.ssoMethod,
    queryFn: ssoApi.method,
    enabled: canSaml || canOidc,
  });
  const saml = useQuery({ queryKey: queryKeys.samlConfig, queryFn: ssoApi.samlConfig, enabled: canSaml });
  const oidc = useQuery({ queryKey: queryKeys.oidcConfig, queryFn: ssoApi.oidcConfig, enabled: canOidc });
  const [picked, setPicked] = useState<Protocol | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDirty = useCallback((value: boolean) => setDirty(value), []);

  const active: SsoMethod = method.data?.method ?? 'email';
  const protocol: Protocol | null =
    picked ?? (active === 'oidc' && canOidc ? 'oidc' : canSaml ? 'saml' : canOidc ? 'oidc' : null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.sso });
    await queryClient.invalidateQueries({ queryKey: ['sso-options'] });
  };

  const saveSaml = useMutation({
    mutationFn: (body: SamlConfigBody) => ssoApi.saveSamlConfig(body),
    onSuccess: async (result) => {
      setError(null);
      queryClient.setQueryData(queryKeys.samlConfig, result);
      await refresh();
      toast.success('SAML settings saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const saveOidc = useMutation({
    mutationFn: (body: OidcConfigBody) => ssoApi.saveOidcConfig(body),
    onSuccess: async (result) => {
      setError(null);
      queryClient.setQueryData(queryKeys.oidcConfig, result);
      await refresh();
      toast.success('OIDC settings saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const testSaml = useMutation({
    mutationFn: ssoApi.testSaml,
    onSuccess: (result) => {
      setError(null);
      openTest(result.url);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const testOidc = useMutation({
    mutationFn: ssoApi.testOidc,
    onSuccess: (result) => {
      setError(null);
      openTest(result.url);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: async ({ which, on }: { which: Protocol; on: boolean }) => {
      if (which === 'saml') return ssoApi.toggleSaml(on);
      return ssoApi.setMethod(on ? 'oidc' : 'email');
    },
    onSuccess: async (_result, { which, on }) => {
      setError(null);
      await refresh();
      toast.success(on ? `${SHORT[which]} sign-in is on` : `${SHORT[which]} sign-in is off`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (!canSaml && !canOidc) {
    return (
      <Panel title="Single sign-on">
        <p className="px-5 py-4 text-sm text-ink-2">
          You don't have access to the single sign-on settings. Ask a workspace owner or admin.
        </p>
      </Panel>
    );
  }
  const loading = method.isLoading || (protocol === 'saml' ? saml.isLoading : oidc.isLoading);
  const loadError = method.error ?? (protocol === 'saml' ? saml.error : oidc.error);
  if (!protocol || loading) {
    return loadError ? <Callout tone="err">{errorMessage(loadError)}</Callout> : <PageLoader />;
  }
  if (loadError) return <Callout tone="err">{errorMessage(loadError)}</Callout>;

  const config = protocol === 'saml' ? saml.data : oidc.data;
  if (!config) return <PageLoader />;
  const isOn = active === protocol;
  const otherOn = active === 'saml' || active === 'oidc' ? active !== protocol : active === 'ldap';
  const savedConfig =
    protocol === 'saml'
      ? Boolean(saml.data?.metadata.trim() || saml.data?.metadataUrl.trim())
      : Boolean(oidc.data?.clientId && oidc.data?.discoveryEndpoint);
  const blocked = isOn
    ? null
    : otherOn
      ? `${active === 'ldap' ? 'LDAP' : SHORT[active as Protocol]} sign-in is on. Turn it off first.`
      : !savedConfig
        ? 'Save the settings first.'
        : dirty
          ? 'Save your changes first.'
          : null;

  const flip = async (on: boolean) => {
    if (on) {
      const ok = await confirmDialog({
        title: `Turn on ${SHORT[protocol]} sign-in?`,
        description: `People will sign in through your identity provider. Password sign-in stops for everyone except owners and the people you allow on the Members page. Run the test first, so you know the sign-in works before you switch.`,
        confirmLabel: `Turn on ${SHORT[protocol]}`,
        tone: 'primary',
      });
      if (!ok) return;
    }
    toggle.mutate({ which: protocol, on });
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title="Single sign-on"
        description="People sign in through your identity provider instead of a password."
        action={
          canSaml && canOidc ? (
            <div className="w-56">
              <Select
                aria-label="Protocol"
                value={protocol}
                onChange={(e) => {
                  setPicked(e.target.value as Protocol);
                  setError(null);
                  setDirty(false);
                }}
              >
                <option value="saml">{NAMES.saml}</option>
                <option value="oidc">{NAMES.oidc}</option>
              </Select>
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <Switch
            label={`Allow ${SHORT[protocol]} sign-in`}
            checked={isOn}
            disabled={toggle.isPending || (blocked !== null && !isOn)}
            onChange={(on) => void flip(on)}
          />
          <span className="text-sm font-medium">Allow {SHORT[protocol]} sign-in</span>
          <Badge tone={isOn ? 'ok' : 'neutral'}>{isOn ? 'On' : 'Off'}</Badge>
          {blocked && <span className="text-sm text-ink-2">{blocked}</span>}
        </div>
        {isOn && (
          <Callout tone="info" className="mx-5 mb-4">
            Owners can still sign in with an email and password. Allow others one by one on the{' '}
            <Link to="/settings/members" className="underline">
              Members page
            </Link>
            .
          </Callout>
        )}
      </Panel>

      <Panel
        title={`${NAMES[protocol]} settings`}
        description="What your identity provider needs and what we need from it."
      >
        <div className="px-5 py-4">
          {protocol === 'saml' && saml.data ? (
            <SamlForm
              config={saml.data}
              saving={saveSaml.isPending}
              testing={testSaml.isPending}
              error={error}
              onSave={(body) => saveSaml.mutate(body)}
              onTest={() => testSaml.mutate()}
              onDirtyChange={onDirty}
            />
          ) : oidc.data ? (
            <OidcForm
              config={oidc.data}
              saving={saveOidc.isPending}
              testing={testOidc.isPending}
              error={error}
              onSave={(body) => saveOidc.mutate(body)}
              onTest={() => testOidc.mutate()}
              onDirtyChange={onDirty}
            />
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
