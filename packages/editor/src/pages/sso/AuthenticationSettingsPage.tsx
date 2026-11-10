/**
 * P6-13: Settings > Authentication: the hub (SSO, LDAP, MFA, provisioning, SCIM) for admins. Each row shows
 * only for the scope its page needs, so a role with none of them sees no hub at all.
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, KeyRound, ShieldCheck, UserCog, Users, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ssoApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { SsoMethod } from '../../api/types';
import { Badge } from '../../components/ui/misc';
import { usePermissions } from '../../lib/permissions';
import { Panel } from '../settings/Panel';

interface HubRow {
  to: string;
  title: string;
  description: string;
  icon: ReactNode;
  visible: boolean;
  /** the badge: on, off, or none */
  on?: boolean;
}

const METHOD_NAMES: Record<SsoMethod, string> = { email: 'Email', saml: 'SAML', oidc: 'OIDC', ldap: 'LDAP' };

export function AuthenticationSettingsPage() {
  const { can } = usePermissions();
  const canSso = can('saml:manage') || can('oidc:manage');
  const canLdap = can('ldap:manage');
  const anyMethod = canSso || canLdap;
  const method = useQuery({ queryKey: queryKeys.ssoMethod, queryFn: ssoApi.method, enabled: anyMethod });
  const active = method.data?.method;

  const rows: HubRow[] = [
    {
      to: '/settings/sso',
      title: 'Single sign-on',
      description: 'SAML or OpenID Connect: people sign in through your identity provider.',
      icon: <KeyRound size={18} />,
      visible: canSso,
      on: active === 'saml' || active === 'oidc',
    },
    {
      to: '/settings/ldap',
      title: 'LDAP',
      description:
        'People sign in with their directory password and the directory keeps the member list in sync.',
      icon: <Users size={18} />,
      visible: canLdap,
      on: active === 'ldap',
    },
    {
      to: '/settings/security',
      title: 'Two-factor authentication',
      description: 'Require everyone in the workspace to sign in with a second step.',
      icon: <ShieldCheck size={18} />,
      visible: can('securitySettings:manage'),
    },
    {
      to: '/settings/provisioning',
      title: 'Role provisioning',
      description: 'Take the workspace role and project roles from the identity provider on each sign-in.',
      icon: <UserCog size={18} />,
      visible: can('provisioning:manage'),
    },
    {
      to: '/settings/scim',
      title: 'SCIM',
      description: 'Let the identity provider add, update and remove members. Needs SAML or OIDC.',
      icon: <Waypoints size={18} />,
      visible: can('scim:manage'),
    },
  ].filter((row) => row.visible);

  // a role may hold only provisioning, SCIM or two-factor: the hub lists the rows it may open
  if (rows.length === 0) {
    return (
      <Panel title="Authentication">
        <p className="px-5 py-4 text-sm text-ink-2">
          You don't have access to the authentication settings. Ask a workspace owner or admin.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Authentication"
      description={
        active
          ? `People sign in with ${METHOD_NAMES[active] === 'Email' ? 'an email and password' : METHOD_NAMES[active]}.`
          : 'How people sign in to this workspace.'
      }
    >
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.to}>
            <Link
              to={row.to}
              className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              <span className="text-ink-2">{row.icon}</span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{row.title}</span>
                <span className="block text-sm text-ink-2">{row.description}</span>
              </span>
              {row.on !== undefined && (
                <Badge tone={row.on ? 'ok' : 'neutral'}>{row.on ? 'On' : 'Off'}</Badge>
              )}
              <ChevronRight size={16} className="text-ink-3" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
