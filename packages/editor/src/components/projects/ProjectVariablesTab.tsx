/** P6-45: `/projects/:id/variables`: the project's variables (`projectVariable:*`); a project value wins. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Variable as VariableIcon } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { variablesApi } from '../../api/endpoints';
import { queryKeys, useProject } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import { useProtectedWorkspace } from '../../lib/protected';
import { VARIABLE_KEY, VariableRow } from '../../pages/SettingsPages';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { FormField, TextInput } from '../ui/Field';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

export interface ProjectVariablesTabProps {
  projectId: string;
}

export function ProjectVariablesTab({ projectId }: ProjectVariablesTabProps) {
  const queryClient = useQueryClient();
  const project = useProject(projectId);
  const { can } = usePermissions();
  const scoped = project.data ?? null;
  const canList = can('projectVariable:list', scoped);
  const canCreate = can('projectVariable:create', scoped);
  // edit needs `projectVariable:update` only (n8n); Delete stays on `projectVariable:delete`, which `can` masks on a
  // protected workspace. There the value still saves and the key does not change.
  const canEdit = can('projectVariable:update', scoped);
  const canDelete = can('projectVariable:delete', scoped);
  const protectedWorkspace = useProtectedWorkspace();
  const variables = useQuery({
    queryKey: queryKeys.projectVariables(projectId),
    queryFn: () => variablesApi.forProject(projectId),
    enabled: canList,
  });
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectVariables(projectId) });
  const create = useMutation({
    mutationFn: () => variablesApi.create({ key: key.trim(), value, projectId }),
    onSuccess: () => {
      setKey('');
      setValue('');
      refresh();
      toast.success('Variable created');
    },
    onError: (error) => toast.error('Could not create the variable', errorMessage(error)),
  });
  const validKey = VARIABLE_KEY.test(key.trim());

  if (project.isLoading) return <PageLoader />;
  if (!canList) return <Callout>You cannot see the variables of this project.</Callout>;
  // only this project's own rows: the workspace ones are on the settings page
  const own = (variables.data ?? []).filter((v) => v.projectId === projectId);
  return (
    <section aria-label="Project variables" className="rounded-2xl border border-line bg-surface shadow-card">
      <header className="border-b border-line px-5 py-4">
        <h2 className="text-md font-semibold">Variables</h2>
        <p className="mt-0.5 text-sm text-ink-2">
          Values for this project's workflows, read as $vars.name. A project variable wins over a workspace
          variable with the same name. Do not store secrets here; use credentials.
        </p>
      </header>
      {canCreate && (
        <form
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-end gap-2 border-b border-line px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (validKey) create.mutate();
          }}
        >
          <FormField
            label="Key"
            error={key && !validKey ? 'Letters, digits and _ only; no leading digit' : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                className="font-mono"
                placeholder="api_region"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Value">
            {(id) => <TextInput id={id} value={value} onChange={(e) => setValue(e.target.value)} />}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} />}
            disabled={!validKey}
            loading={create.isPending}
          >
            Add
          </Button>
        </form>
      )}
      {variables.isLoading ? (
        <PageLoader />
      ) : variables.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(variables.error)}
        </Callout>
      ) : !own.length ? (
        <EmptyState
          icon={<VariableIcon size={20} />}
          title="No variables in this project"
          description={
            canCreate
              ? 'Add values that this project shares, like a region or a base URL.'
              : 'Nothing is set for this project yet.'
          }
        />
      ) : (
        <ul>
          {own.map((v) => (
            <VariableRow
              key={`${v.id}:${v.key}:${v.value}`}
              variable={v}
              onSaved={refresh}
              readOnly={!canEdit}
              keyLocked={protectedWorkspace}
              canDelete={canDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
