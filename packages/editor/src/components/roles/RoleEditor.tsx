/**
 * P6-46: name, description and the scope checkboxes by resource (allow lists of custom-role-scopes.ts), with
 * the escalation warnings; the instance editor shows the static personal space block.
 */
import {
  COUPLED_HIDDEN_SCOPES,
  GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS,
  listCompanionOf,
  MANDATORY_INSTANCE_OPTIONS,
  PROJECT_CUSTOM_ROLE_OPERATIONS,
} from '@workflow/workflow';
import type { Scope } from '../../api/types';
import type { RoleKind } from '../../pages/RolesPages';
import { Checkbox, FormField, TextArea, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';

export interface RoleDraft {
  displayName: string;
  description: string;
  scopes: Scope[];
}

export interface RoleEditorProps {
  roleType: RoleKind;
  value: RoleDraft;
  onChange(next: RoleDraft): void;
  readOnly?: boolean;
}

const OPERATIONS: Readonly<Record<string, readonly string[]>> = PROJECT_CUSTOM_ROLE_OPERATIONS;
const GROUPS: Readonly<Record<string, Readonly<Record<string, readonly Scope[]>>>> =
  GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS;

const RESOURCE_LABELS: Record<string, string> = {
  project: 'Project',
  folder: 'Folder',
  workflow: 'Workflow',
  credential: 'Credential',
  execution: 'Execution',
  externalSecretsProvider: 'Secrets vault',
  externalSecret: 'Secret',
  sourceControl: 'Source control',
  dataTable: 'Data table',
  projectVariable: 'Project variable',
};

const GROUP_LABELS: Record<string, string> = {
  settings: 'Settings',
  user: 'Users',
  role: 'Roles',
  apiKey: 'API keys',
  tag: 'Tags',
  variable: 'Variables',
  credential: 'Credentials',
  project: 'Projects',
  insights: 'Insights',
};

const OPERATION_LABELS: Record<string, string> = {
  manageMembers: 'Manage members',
  readRow: 'Read rows',
  writeRow: 'Write rows',
  readColumn: 'Read columns',
  writeColumn: 'Write columns',
  enableRedaction: 'Enable redaction',
  disableRedaction: 'Disable redaction',
  push: 'Push',
};

function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation.charAt(0).toUpperCase() + operation.slice(1);
}

/** n8n's escalation warnings, in our words: a role that can hand out access can raise its own */
const WARNINGS: ReadonlyArray<{ key: string; text: string; active(scopes: ReadonlySet<Scope>): boolean }> = [
  {
    key: 'manageMembers',
    text: 'People with this role can change anyone’s workspace role, including their own, so they can give themselves more access.',
    active: (s) => s.has('user:changeRole'),
  },
  {
    key: 'manageRoles',
    text: 'People with this role can edit every role, including their own, so they can give themselves any access.',
    active: (s) => s.has('role:manage'),
  },
  {
    key: 'manageProjectRoles',
    text: 'People with this role can edit project roles, including the one they hold in a project, so they can widen their own access there.',
    active: (s) => s.has('role:manageProject'),
  },
  {
    key: 'manageCredentials',
    text: 'People with this role can share, move and delete credentials in every project, including ones they cannot see.',
    active: (s) => s.has('credential:share') && s.has('credential:delete'),
  },
];

const MANDATORY_KEYS = new Set<string>(MANDATORY_INSTANCE_OPTIONS.map((o) => `${o.resource}:${o.option}`));

/** a project-role checkbox: a read brings its list scope, any other operation brings read, publish brings unpublish */
export function toggleProjectScope(current: readonly Scope[], scope: Scope, on: boolean): Scope[] {
  const next = new Set<Scope>(current);
  const [resource, operation] = scope.split(':') as [string, string];
  const readScope = `${resource}:read` as Scope;
  const addWithCompanion = (s: Scope) => {
    next.add(s);
    const companion = listCompanionOf(s);
    if (companion) next.add(companion);
  };
  const removeWithCompanion = (s: Scope) => {
    next.delete(s);
    const companion = listCompanionOf(s);
    if (companion) next.delete(companion);
    if (s === 'workflow:publish') for (const hidden of COUPLED_HIDDEN_SCOPES) next.delete(hidden);
  };
  if (on) {
    addWithCompanion(scope);
    if (scope === 'workflow:publish') for (const hidden of COUPLED_HIDDEN_SCOPES) next.add(hidden);
    if (operation !== 'read' && OPERATIONS[resource]?.includes('read')) addWithCompanion(readScope);
  } else {
    removeWithCompanion(scope);
    if (operation === 'read') {
      for (const other of OPERATIONS[resource] ?? []) removeWithCompanion(`${resource}:${other}` as Scope);
    }
  }
  return [...next];
}

function optionChecked(scopes: ReadonlySet<Scope>, option: readonly Scope[]): boolean {
  return option.every((s) => scopes.has(s));
}

/** a workspace-role option on or off; turning one off also turns off the options that contain it */
export function toggleGlobalOption(
  current: readonly Scope[],
  group: string,
  optionName: string,
  on: boolean,
): Scope[] {
  const option = GROUPS[group]?.[optionName] ?? [];
  const next = new Set<Scope>(current);
  if (on) {
    for (const s of option) next.add(s);
    return [...next];
  }
  const containing = Object.entries(GROUPS[group] ?? {}).filter(
    ([, scopes]) => scopes.length >= option.length && option.every((s) => scopes.includes(s)),
  );
  const containingNames = new Set(containing.map(([name]) => name));
  for (const [, scopes] of containing) for (const s of scopes) next.delete(s);
  // an option that stays checked keeps all its scopes, even those it shares with the one turned off
  const held = new Set<Scope>(current);
  for (const [otherGroup, options] of Object.entries(GROUPS)) {
    for (const [name, scopes] of Object.entries(options)) {
      if (otherGroup === group && containingNames.has(name)) continue;
      if (optionChecked(held, scopes)) for (const s of scopes) next.add(s);
    }
  }
  return [...next];
}

export function RoleEditor({ roleType, value, onChange, readOnly }: RoleEditorProps) {
  const held = new Set<Scope>(value.scopes);
  const set = (patch: Partial<RoleDraft>) => onChange({ ...value, ...patch });

  const warnings = WARNINGS.filter((w) => w.active(held));

  return (
    <div className="flex flex-col gap-5">
      <FormField label="Name" required>
        {(id) => (
          <TextInput
            id={id}
            value={value.displayName}
            maxLength={100}
            readOnly={readOnly}
            onChange={(e) => set({ displayName: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Description">
        {(id) => (
          <TextArea
            id={id}
            rows={2}
            value={value.description}
            maxLength={500}
            readOnly={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        )}
      </FormField>

      {warnings.length > 0 && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" aria-label="Warnings">
          {warnings.map((w) => (
            <Callout key={w.key} tone="warn" title="This role can raise access">
              <span data-warning={w.key}>{w.text}</span>
            </Callout>
          ))}
        </fieldset>
      )}

      {roleType === 'project' ? (
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-md font-semibold text-ink">Permissions</h3>
          {Object.entries(OPERATIONS).map(([resource, operations]) => (
            <fieldset key={resource} className="rounded-lg border border-line px-3 py-2">
              <legend className="px-1 text-sm font-semibold text-ink">
                {RESOURCE_LABELS[resource] ?? resource}
              </legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {operations.map((operation) => {
                  const scope = `${resource}:${operation}` as Scope;
                  return (
                    <Checkbox
                      key={scope}
                      label={operationLabel(operation)}
                      aria-label={`${RESOURCE_LABELS[resource] ?? resource} ${operationLabel(operation).toLowerCase()}`}
                      checked={held.has(scope)}
                      disabled={readOnly}
                      onChange={(e) =>
                        set({ scopes: toggleProjectScope(value.scopes, scope, e.target.checked) })
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-md font-semibold text-ink">Permissions</h3>
          {Object.entries(GROUPS).map(([group, options]) => (
            <fieldset key={group} className="rounded-lg border border-line px-3 py-2">
              <legend className="px-1 text-sm font-semibold text-ink">{GROUP_LABELS[group] ?? group}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {Object.entries(options).map(([name, scopes]) => {
                  const mandatory = MANDATORY_KEYS.has(`${group}:${name}`);
                  return (
                    <Checkbox
                      key={name}
                      label={name}
                      aria-label={`${GROUP_LABELS[group] ?? group}: ${name}`}
                      checked={mandatory || optionChecked(held, scopes)}
                      disabled={readOnly || mandatory}
                      title={mandatory ? 'Every workspace role has this' : undefined}
                      onChange={(e) =>
                        set({ scopes: toggleGlobalOption(value.scopes, group, name, e.target.checked) })
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
          ))}
          <section
            aria-label="Personal space"
            className="rounded-lg border border-dashed border-line bg-surface-2 px-3 py-2 text-sm"
          >
            <h3 className="font-semibold text-ink">Personal space</h3>
            <p className="mt-1 text-ink-2">
              Everyone in the workspace has a personal space. They can create and manage their own workflows,
              credentials, folders and data tables there, whatever role they hold. Publishing and sharing from
              it are set under Security, not here.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
