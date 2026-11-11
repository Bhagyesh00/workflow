/**
 * Settings: the layout and nav. Account, members, API keys and variables live in pages/settings/ (P6-S2,
 * variables P6-S4) and are re-exported here, so App.tsx's and ProjectVariablesTab.tsx's imports hold.
 */
import { NavLink, Outlet } from 'react-router';
import { cx } from '../components/ui/cx';
import { usePermissions } from '../lib/permissions';

export { AccountSettingsPage } from './settings/AccountSettingsPage';
export { ApiKeysSettingsPage } from './settings/ApiKeysSettingsPage';
export { MembersSettingsPage } from './settings/MembersSettingsPage';
export { VARIABLE_KEY, VariableRow, VariablesSettingsPage } from './settings/VariablesSettingsPage';

export function SettingsLayout() {
  const { can } = usePermissions();
  const links = [
    { to: '/settings/account', label: 'Your account' },
    { to: '/settings/members', label: 'Members' },
    // P6-84: every signed-in user, as n8n (no scope)
    { to: '/settings/usage', label: 'Usage' },
    // P6-46: project and instance roles
    ...(can('role:manage') ? [{ to: '/settings/roles', label: 'Roles' }] : []),
    { to: '/settings/api-keys', label: 'API keys' },
    { to: '/settings/variables', label: 'Variables' },
    { to: '/settings/security', label: 'Security' },
    // P6-13: SSO, LDAP, MFA, provisioning and SCIM, for whoever holds the scope of one of the hub's rows
    ...(can('saml:manage') ||
    can('oidc:manage') ||
    can('ldap:manage') ||
    can('provisioning:manage') ||
    can('scim:manage') ||
    can('securitySettings:manage')
      ? [{ to: '/settings/authentication', label: 'Authentication' }]
      : []),
    // P6-45: each link by the scope its page needs (owner and admin hold all three)
    ...(can('externalSecretsProvider:list')
      ? [{ to: '/settings/external-secrets', label: 'External secrets' }]
      : []),
    // P6-76: the Git connection and the protected workspace switch (n8n's Environments)
    ...(can('sourceControl:manage') ? [{ to: '/settings/environments', label: 'Environments' }] : []),
    // P5-09: the builder's model
    ...(can('aiAssistant:manage') ? [{ to: '/settings/ai', label: 'AI' }] : []),
    // P5-71: the Assistant's model, search, permissions and MCP connections
    ...(can('instanceAi:manage') ? [{ to: '/settings/assistant', label: 'Assistant' }] : []),
    // P5-04: every role (the page shows each role what it may do; the MCP key is per user)
    { to: '/settings/mcp', label: 'MCP' },
  ];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8 md:flex-row">
      <nav aria-label="Settings" className="shrink-0 md:w-52">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <ul className="flex gap-1 md:flex-col">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                className={({ isActive }) =>
                  cx(
                    'block rounded-lg px-3 py-2 text-sm font-semibold',
                    isActive ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                  )
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
