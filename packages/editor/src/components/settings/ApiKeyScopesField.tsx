/** Scope picker of the API key form (P4-18): every scope, or only the ones ticked. */
import { useId, useState } from 'react';
import { Checkbox } from '../ui/Field';

export interface ApiKeyScopesFieldProps {
  /** the picked scopes; empty means every scope */
  value: string[];
  onChange(next: string[]): void;
  /** the mode changed: true is "only the scopes I pick", so the form can refuse that with nothing picked */
  onModeChange?(only: boolean): void;
  disabled?: boolean;
}

/** n8n's public API scopes, by resource (the server's API_KEY_SCOPES; S3's groups appended last in both) */
const GROUPS: Array<{ resource: string; label: string; scopes: string[] }> = [
  {
    resource: 'workflow',
    label: 'Workflows',
    scopes: ['list', 'read', 'create', 'update', 'delete', 'move', 'activate', 'deactivate'],
  },
  { resource: 'workflowTags', label: 'Workflow tags', scopes: ['list', 'update'] },
  { resource: 'execution', label: 'Executions', scopes: ['list', 'read', 'retry', 'stop', 'delete'] },
  {
    resource: 'credential',
    label: 'Credentials',
    scopes: ['list', 'read', 'create', 'update', 'move', 'delete'],
  },
  { resource: 'tag', label: 'Tags', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  { resource: 'variable', label: 'Variables', scopes: ['list', 'create', 'update', 'delete'] },
  { resource: 'folder', label: 'Folders', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  {
    resource: 'project',
    label: 'Projects',
    scopes: ['list', 'create', 'update', 'delete', 'manageMembers'],
  },
  // P6-32, P6-33
  { resource: 'role', label: 'Roles', scopes: ['list', 'read', 'manage', 'manageProject'] },
  { resource: 'securitySettings', label: 'Security settings', scopes: ['manage'] },
  { resource: 'user', label: 'Users', scopes: ['list', 'read', 'create', 'changeRole', 'delete'] },
  { resource: 'dataTable', label: 'Data tables', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  {
    resource: 'dataTableColumn',
    label: 'Data table columns',
    scopes: ['read', 'create', 'update', 'delete'],
  },
  {
    resource: 'dataTableRow',
    label: 'Data table rows',
    scopes: ['read', 'create', 'update', 'upsert', 'delete'],
  },
  // P5-12: evaluations of the public API
  { resource: 'testRun', label: 'Test runs', scopes: ['list', 'create', 'read', 'cancel'] },
  { resource: 'sourceControl', label: 'Source control', scopes: ['pull', 'push', 'read'] },
  { resource: 'securityAudit', label: 'Security audit', scopes: ['generate'] },
  // P6-09, P6-10, P6-11, P6-12: sign-in methods and role mapping
  { resource: 'saml', label: 'SAML', scopes: ['manage'] },
  { resource: 'oidc', label: 'OIDC', scopes: ['manage'] },
  { resource: 'ldap', label: 'LDAP', scopes: ['manage', 'sync'] },
  {
    resource: 'roleMappingRule',
    label: 'Role mapping rules',
    scopes: ['list', 'create', 'update', 'delete'],
  },
  // P6-49, P6-05: appended last here and in the server's API_KEY_SCOPES
  { resource: 'nodeTypePolicy', label: 'Node type policies', scopes: ['manage'] },
  { resource: 'credentialTypePolicy', label: 'Credential type policies', scopes: ['manage'] },
  { resource: 'insights', label: 'Insights', scopes: ['read'] },
];

const withScopes = GROUPS.map((group) => ({
  ...group,
  all: group.scopes.map((action) => `${group.resource}:${action}`),
}));

export function ApiKeyScopesField({ value, onChange, onModeChange, disabled }: ApiKeyScopesFieldProps) {
  const name = useId();
  // a key with nothing ticked has every scope, so "only these" is tracked apart from the value
  const [only, setOnly] = useState(value.length > 0);
  const picked = new Set(value);

  const toggle = (scope: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(scope);
    else next.delete(scope);
    onChange(withScopes.flatMap((group) => group.all).filter((s) => next.has(s)));
  };
  const toggleGroup = (all: string[], on: boolean) => {
    const next = new Set(picked);
    for (const scope of all) {
      if (on) next.add(scope);
      else next.delete(scope);
    }
    onChange(withScopes.flatMap((group) => group.all).filter((s) => next.has(s)));
  };

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled} data-testid="api-key-scopes">
      <legend className="mb-1 text-sm font-medium text-ink-2">Scopes</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={name}
            className="size-4 accent-[var(--wf-brand)]"
            checked={!only}
            onChange={() => {
              setOnly(false);
              onModeChange?.(false);
              onChange([]);
            }}
          />
          <span>All scopes</span>
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={name}
            className="size-4 accent-[var(--wf-brand)]"
            checked={only}
            onChange={() => {
              setOnly(true);
              onModeChange?.(true);
            }}
          />
          <span>Only the scopes I pick</span>
        </label>
      </div>
      {only ? (
        <>
          {value.length === 0 ? (
            <p className="text-xs text-ink-3" data-testid="scope-summary">
              Nothing picked yet: pick at least one scope, or choose All scopes.
            </p>
          ) : (
            <p className="text-xs text-ink-3" data-testid="scope-summary">
              {value.length} {value.length === 1 ? 'scope' : 'scopes'} picked. Any other route answers 403.
            </p>
          )}
          <div className="grid max-h-72 gap-3 overflow-y-auto rounded-md border border-line p-3 sm:grid-cols-2">
            {withScopes.map((group) => {
              const count = group.all.filter((scope) => picked.has(scope)).length;
              return (
                <fieldset
                  key={group.resource}
                  className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
                  aria-label={group.label}
                >
                  <Checkbox
                    label={<span className="font-medium">{group.label}</span>}
                    checked={count === group.all.length}
                    ref={(el) => {
                      if (el) el.indeterminate = count > 0 && count < group.all.length;
                    }}
                    onChange={(e) => toggleGroup(group.all, e.target.checked)}
                    aria-label={`All ${group.label.toLowerCase()} scopes`}
                  />
                  <div className="ml-6 flex flex-wrap gap-x-3 gap-y-1">
                    {group.all.map((scope) => (
                      <Checkbox
                        key={scope}
                        label={scope.slice(scope.indexOf(':') + 1)}
                        checked={picked.has(scope)}
                        onChange={(e) => toggle(scope, e.target.checked)}
                        aria-label={scope}
                        className="text-xs"
                      />
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-ink-3">The key can use every route of the public API.</p>
      )}
    </fieldset>
  );
}
