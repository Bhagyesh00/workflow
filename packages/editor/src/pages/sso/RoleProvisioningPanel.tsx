/**
 * P6-11: Settings > Authentication > Provisioning: role assignment (manual, workspace, workspace and
 * project), claims or rules, the rule list and editor, a CSV of current access before removing project rules.
 * The owner is never assigned from the provider; a person with no matching role gets the default condition
 * (keep the current role, a role, or no access).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { projectsApi, provisioningApi, rolesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { CustomRole, ProvisioningConfig, RoleMappingRule, RoleMappingRuleBody } from '../../api/types';
import { AccessCsvButton } from '../../components/sso/AccessCsvButton';
import { RoleRuleEditor } from '../../components/sso/RoleRuleEditor';
import { Button, IconButton } from '../../components/ui/Button';
import { confirmDialog } from '../../components/ui/Dialog';
import { FormField, Select, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Panel } from '../settings/Panel';

type Mode = 'manual' | 'instance' | 'project';
type Mapping = 'claims' | 'rules';

/** the server also answers and takes the default condition (`defaultInstanceRole`) */
type Config = ProvisioningConfig;

const BLOCK = 'block';
const KEEP = '';

const modeOf = (config: Config): Mode =>
  config.scopesProvisionProjectRoles ? 'project' : config.scopesProvisionInstanceRole ? 'instance' : 'manual';

function RuleRow({
  rule,
  index,
  count,
  roleName,
  projectNames,
  canUpdate,
  canDelete,
  busy,
  onMove,
  onEdit,
  onDelete,
}: {
  rule: RoleMappingRule;
  index: number;
  count: number;
  roleName: string;
  projectNames: string[];
  canUpdate: boolean;
  canDelete: boolean;
  busy: boolean;
  onMove: (position: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0">
      <span className="mt-0.5 w-6 shrink-0 text-sm text-ink-3">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <code className="block overflow-x-auto whitespace-pre-wrap break-all text-xs">{rule.expression}</code>
        <p className="mt-1 text-sm text-ink-2">
          Gives {roleName}
          {rule.type === 'project' && projectNames.length > 0 ? ` in ${projectNames.join(', ')}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canUpdate && (
          <>
            <IconButton
              label="Move up"
              size="sm"
              disabled={busy || index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ArrowUp size={13} />
            </IconButton>
            <IconButton
              label="Move down"
              size="sm"
              disabled={busy || index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              <ArrowDown size={13} />
            </IconButton>
            <IconButton label="Edit rule" size="sm" disabled={busy} onClick={onEdit}>
              <Pencil size={13} />
            </IconButton>
          </>
        )}
        {canDelete && (
          <IconButton label="Delete rule" size="sm" disabled={busy} onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
    </li>
  );
}

export function RoleProvisioningPanel() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canManage = can('provisioning:manage');
  const canList = can('roleMappingRule:list');
  const config = useQuery({
    queryKey: queryKeys.provisioningConfig,
    queryFn: provisioningApi.config,
    enabled: canManage,
  });
  const rules = useQuery({
    queryKey: queryKeys.roleMappingRules,
    queryFn: provisioningApi.rules,
    enabled: canManage && canList,
  });
  const roles = useQuery({ queryKey: queryKeys.roles, queryFn: rolesApi.list, enabled: canManage });
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: projectsApi.list, enabled: canManage });

  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    type: 'instance' | 'project';
    rule: RoleMappingRule | null;
  } | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);

  useEffect(() => {
    if (config.data && !draft) setDraft({ ...config.data });
  }, [config.data, draft]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.provisioningConfig });
    await queryClient.invalidateQueries({ queryKey: queryKeys.roleMappingRules });
  };

  const save = useMutation({
    mutationFn: (body: Partial<Config>) => provisioningApi.updateConfig(body as Partial<ProvisioningConfig>),
    onSuccess: async (saved) => {
      setError(null);
      setDraft({ ...(saved as Config) });
      queryClient.setQueryData(queryKeys.provisioningConfig, saved);
      await refresh();
      toast.success('Provisioning settings saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const saveRule = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: RoleMappingRuleBody }) =>
      id ? provisioningApi.updateRule(id, body) : provisioningApi.createRule(body),
    onSuccess: async () => {
      setRuleError(null);
      setEditing(null);
      await refresh();
      toast.success('Rule saved');
    },
    onError: (e) => setRuleError(errorMessage(e)),
  });
  const move = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      provisioningApi.moveRule(id, position),
    onSuccess: refresh,
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => provisioningApi.deleteRule(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Rule deleted');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (!canManage) {
    return (
      <Panel title="Role provisioning">
        <p className="px-5 py-4 text-sm text-ink-2">
          You don't have access to role provisioning. Ask a workspace owner or admin.
        </p>
      </Panel>
    );
  }
  const loadError = config.error ?? roles.error ?? projects.error;
  if (loadError) return <Callout tone="err">{errorMessage(loadError)}</Callout>;
  if (!config.data || !draft || !roles.data || !projects.data) return <PageLoader />;

  const saved = config.data as Config;
  const mode = modeOf(draft);
  const mapping: Mapping = draft.scopesUseExpressionMapping ? 'rules' : 'claims';
  const instanceRoles: CustomRole[] = roles.data.global.filter((r) => r.slug !== 'owner');
  const projectRoles: CustomRole[] = roles.data.project.filter((r) => r.slug !== 'project:personalOwner');
  const teamProjects = projects.data.filter((p) => p.type === 'team');
  const nameOfRole = (list: CustomRole[], slug: string) =>
    list.find((r) => r.slug === slug)?.displayName ?? slug;
  const nameOfProject = (id: string) => teamProjects.find((p) => p.id === id)?.name ?? 'a project';

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (changes: Partial<Config>) => setDraft({ ...draft, ...changes });
  const setMode = (next: Mode) =>
    patch({
      scopesProvisionInstanceRole: next !== 'manual',
      scopesProvisionProjectRoles: next === 'project',
    });

  const ruleList = rules.data ?? [];
  const projectRuleCount = ruleList.filter((r) => r.type === 'project').length;

  const submit = async () => {
    const turnsOn = modeOf(saved) === 'manual' && mode !== 'manual';
    const dropsProjects = saved.scopesProvisionProjectRoles && !draft.scopesProvisionProjectRoles;
    if (turnsOn || dropsProjects) {
      const ok = await confirmDialog({
        title: turnsOn ? 'Take roles from your identity provider?' : 'Stop managing project roles?',
        description: (
          <div className="flex flex-col gap-3">
            <p>
              {turnsOn
                ? 'On each sign-in, roles are set from the claims or rules below. People who sign in with no matching role get the default condition, and roles you set by hand are replaced. Download who holds which role first, so you can restore it.'
                : `Project roles stop coming from your identity provider and the ${projectRuleCount} project ${
                    projectRuleCount === 1 ? 'rule is' : 'rules are'
                  } deleted. Download who holds which role first.`}
            </p>
            <div>
              <AccessCsvButton onError={(message) => setError(message)} />
            </div>
          </div>
        ),
        confirmLabel: turnsOn ? 'Turn on' : 'Stop managing',
        tone: 'primary',
      });
      if (!ok) return;
    }
    save.mutate({
      scopesProvisionInstanceRole: draft.scopesProvisionInstanceRole,
      scopesProvisionProjectRoles: draft.scopesProvisionProjectRoles,
      scopesUseExpressionMapping: draft.scopesUseExpressionMapping,
      scopesName: draft.scopesName,
      scopesInstanceRoleClaimName: draft.scopesInstanceRoleClaimName,
      scopesProjectsRolesClaimName: draft.scopesProjectsRolesClaimName,
      defaultInstanceRole: draft.defaultInstanceRole ?? null,
    });
  };

  const deleteRule = async (rule: RoleMappingRule) => {
    const ok = await confirmDialog({
      title: 'Delete this rule?',
      description:
        'People who matched it get the next matching rule, or the default condition, on their next sign-in.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(rule.id);
  };

  const section = (type: 'instance' | 'project') => {
    const list = ruleList.filter((r) => r.type === type).sort((a, b) => a.order - b.order);
    const available = type === 'instance' ? instanceRoles : projectRoles;
    return (
      <Panel
        key={type}
        title={type === 'instance' ? 'Workspace role rules' : 'Project role rules'}
        description={
          type === 'instance'
            ? 'The first rule that matches gives the workspace role.'
            : 'The first rule that matches gives the project role in its projects.'
        }
        action={
          can('roleMappingRule:create') ? (
            <Button
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => {
                setRuleError(null);
                setEditing({ type, rule: null });
              }}
            >
              {type === 'instance' ? 'Add workspace rule' : 'Add project rule'}
            </Button>
          ) : undefined
        }
      >
        {list.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-2">
            No rules yet.{' '}
            {type === 'instance' ? 'Everyone gets the default condition.' : 'No project roles are set.'}
          </p>
        ) : (
          <ul aria-label={type === 'instance' ? 'Workspace rules' : 'Project rules'}>
            {list.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={index}
                count={list.length}
                roleName={nameOfRole(available, rule.role)}
                projectNames={rule.projectIds.map(nameOfProject)}
                canUpdate={can('roleMappingRule:update')}
                canDelete={can('roleMappingRule:delete')}
                busy={move.isPending || remove.isPending}
                onMove={(position) => move.mutate({ id: rule.id, position })}
                onEdit={() => {
                  setRuleError(null);
                  setEditing({ type, rule });
                }}
                onDelete={() => void deleteRule(rule)}
              />
            ))}
          </ul>
        )}
      </Panel>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Role provisioning"
        description="Set workspace and project roles from your identity provider on each sign-in. The owner is never changed."
      >
        <form
          aria-label="Role provisioning"
          className="flex flex-col gap-4 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && <Callout tone="err">{error}</Callout>}
          <FormField label="Assign roles">
            {(id) => (
              <Select id={id} value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
                <option value="manual">Manually, in this workspace</option>
                <option value="instance">Workspace roles from the identity provider</option>
                <option value="project">Workspace and project roles from the identity provider</option>
              </Select>
            )}
          </FormField>
          {mode !== 'manual' && (
            <>
              <FormField
                label="Role source"
                hint="Claims read a role from the sign-in; rules test a condition on the claims."
              >
                {(id) => (
                  <Select
                    id={id}
                    value={mapping}
                    onChange={(event) =>
                      patch({ scopesUseExpressionMapping: event.target.value === 'rules' })
                    }
                  >
                    <option value="claims">Claims</option>
                    <option value="rules">Rules</option>
                  </Select>
                )}
              </FormField>
              {mapping === 'claims' && (
                <>
                  <FormField label="Scope" hint="Asked for from the identity provider at sign-in.">
                    {(id) => (
                      <TextInput
                        id={id}
                        value={draft.scopesName}
                        onChange={(event) => patch({ scopesName: event.target.value })}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Workspace role claim"
                    hint="Holds a role name, such as admin, member or a custom workspace role."
                  >
                    {(id) => (
                      <TextInput
                        id={id}
                        value={draft.scopesInstanceRoleClaimName}
                        onChange={(event) => patch({ scopesInstanceRoleClaimName: event.target.value })}
                      />
                    )}
                  </FormField>
                  {mode === 'project' && (
                    <FormField
                      label="Project roles claim"
                      hint="A list of project-id:role entries. The last entry for a project wins, and the list replaces the project roles the person has."
                    >
                      {(id) => (
                        <TextInput
                          id={id}
                          value={draft.scopesProjectsRolesClaimName}
                          onChange={(event) => patch({ scopesProjectsRolesClaimName: event.target.value })}
                        />
                      )}
                    </FormField>
                  )}
                </>
              )}
              <FormField
                label="When no role matches"
                hint="Applies to a person whose claims or rules give no workspace role."
              >
                {(id) => (
                  <Select
                    id={id}
                    value={draft.defaultInstanceRole ?? KEEP}
                    onChange={(event) => patch({ defaultInstanceRole: event.target.value || null })}
                  >
                    <option value={KEEP}>Keep the role the person has</option>
                    {instanceRoles.map((role) => (
                      <option key={role.slug} value={role.slug}>
                        Give {role.displayName}
                      </option>
                    ))}
                    <option value={BLOCK}>Deny access</option>
                  </Select>
                )}
              </FormField>
            </>
          )}
          <div className="flex items-center justify-between gap-3">
            <AccessCsvButton onError={(message) => setError(message)} />
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
          </div>
        </form>
      </Panel>
      {saved.scopesProvisionInstanceRole && saved.scopesUseExpressionMapping && canList && (
        <>
          {rules.error && <Callout tone="err">{errorMessage(rules.error)}</Callout>}
          {section('instance')}
          {saved.scopesProvisionProjectRoles && section('project')}
        </>
      )}
      {editing && (
        <RoleRuleEditor
          key={editing.rule?.id ?? 'new'}
          type={editing.type}
          rule={editing.rule}
          roles={editing.type === 'instance' ? instanceRoles : projectRoles}
          projects={teamProjects}
          saving={saveRule.isPending}
          error={ruleError}
          onSave={(body) => saveRule.mutate({ id: editing.rule?.id ?? null, body })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
