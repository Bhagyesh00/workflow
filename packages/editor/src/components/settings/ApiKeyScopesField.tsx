/** Scope picker of the API key form (P4-18): every scope, or only the ones ticked. */
import { useId, useState } from 'react';
import { Checkbox } from '../ui/Field';

export interface ApiKeyScopesFieldProps {
  /** the picked scopes; empty means every scope */
  value: string[];
  onChange(next: string[]): void;
  disabled?: boolean;
}

/** n8n's public API scopes, by resource (the server's API_KEY_SCOPES, same order) */
const GROUPS: Array<{ resource: string; label: string; scopes: string[] }> = [
  { resource: 'workflow', label: 'Workflows', scopes: ['list', 'read', 'create', 'update', 'delete', 'move', 'activate', 'deactivate'] },
  { resource: 'workflowTags', label: 'Workflow tags', scopes: ['list', 'update'] },
  { resource: 'execution', label: 'Executions', scopes: ['list', 'read', 'retry', 'stop', 'delete'] },
  { resource: 'credential', label: 'Credentials', scopes: ['list', 'read', 'create', 'update', 'move', 'delete'] },
  { resource: 'tag', label: 'Tags', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  { resource: 'variable', label: 'Variables', scopes: ['list', 'create', 'update', 'delete'] },
  { resource: 'folder', label: 'Folders', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  { resource: 'project', label: 'Projects', scopes: ['list', 'create', 'update', 'delete'] },
  { resource: 'user', label: 'Users', scopes: ['list', 'read', 'create', 'changeRole', 'delete'] },
  { resource: 'dataTable', label: 'Data tables', scopes: ['list', 'read', 'create', 'update', 'delete'] },
  { resource: 'dataTableColumn', label: 'Data table columns', scopes: ['read', 'create', 'update', 'delete'] },
  { resource: 'dataTableRow', label: 'Data table rows', scopes: ['read', 'create', 'update', 'upsert', 'delete'] },
  { resource: 'sourceControl', label: 'Source control', scopes: ['pull'] },
  { resource: 'securityAudit', label: 'Security audit', scopes: ['generate'] },
];

const withScopes = GROUPS.map((group) => ({
  ...group,
  all: group.scopes.map((action) => `${group.resource}:${action}`),
}));

export function ApiKeyScopesField({ value, onChange, disabled }: ApiKeyScopesFieldProps) {
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
            onChange={() => setOnly(true)}
          />
          <span>Only the scopes I pick</span>
        </label>
      </div>
      {only ? (
        <>
          {value.length === 0 ? (
            <p className="text-xs text-ink-3" data-testid="scope-summary">
              Nothing picked yet: a key with no scopes can use every route.
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
                <div key={group.resource} className="flex flex-col gap-1" role="group" aria-label={group.label}>
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
                </div>
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
