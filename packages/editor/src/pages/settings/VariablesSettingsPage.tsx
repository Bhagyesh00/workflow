/**
 * Settings > Variables: the workspace's variables. Moved unchanged from SettingsPages.tsx (P6-S4 C0), which
 * re-exports `VARIABLE_KEY`, `VariableRow` and `VariablesSettingsPage`, so App.tsx and ProjectVariablesTab.tsx
 * keep their imports (L9, P6-80, owns this file after C0).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Variable as VariableIcon } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { variablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { Variable } from '../../api/types';
import { Button, IconButton } from '../../components/ui/Button';
import { confirmDialog } from '../../components/ui/Dialog';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../../components/ui/misc';
import { usePermissions } from '../../lib/permissions';
import { useProtectedWorkspace } from '../../lib/protected';
import { toast } from '../../stores/ui-store';
import { Panel } from './Panel';

export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function VariableRow({
  variable,
  onSaved,
  readOnly = false,
  keyLocked = false,
  canDelete,
}: {
  variable: Variable;
  onSaved: () => void;
  /** no right to change the row: key, value and Save are locked */
  readOnly?: boolean;
  /** P6-80: the key stays as it is (a protected workspace) while the value still saves */
  keyLocked?: boolean;
  /** the Delete button shows; defaults to the row being editable */
  canDelete?: boolean;
}) {
  const mayDelete = canDelete ?? !readOnly;
  const [key, setKey] = useState(variable.key);
  const [value, setValue] = useState(variable.value);
  const dirty = key !== variable.key || value !== variable.value;
  const save = useMutation({
    mutationFn: () => variablesApi.update(variable.id, { key, value }),
    onSuccess: () => {
      onSaved();
      toast.success('Variable saved');
    },
    onError: (error) => toast.error('Could not save the variable', errorMessage(error)),
  });
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete $vars.${variable.key}?`,
      description: 'Expressions that read it get undefined.',
      confirmLabel: 'Delete variable',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await variablesApi.remove(variable.id);
      onSaved();
    } catch (error) {
      toast.error('Could not delete the variable', errorMessage(error));
    }
  };
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2 border-b border-line px-5 py-2.5 last:border-b-0">
      <TextInput
        aria-label="Key"
        className="font-mono"
        value={key}
        readOnly={readOnly || keyLocked}
        onChange={(e) => setKey(e.target.value)}
        aria-invalid={!VARIABLE_KEY.test(key) || undefined}
      />
      <TextInput
        aria-label={`Value of ${variable.key}`}
        value={value}
        readOnly={readOnly}
        onChange={(e) => setValue(e.target.value)}
      />
      <span className="flex gap-1">
        {!readOnly && (
          <Button
            size="sm"
            variant={dirty ? 'primary' : 'ghost'}
            disabled={!dirty || !VARIABLE_KEY.test(key)}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        )}
        {mayDelete && (
          <IconButton label={`Delete ${variable.key}`} size="sm" onClick={() => void remove()}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </span>
    </li>
  );
}

export function VariablesSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canCreate = can('variable:create');
  // edit needs `variable:update` only (n8n); Delete stays on `variable:delete`, which `can` masks on a protected
  // workspace. There the value still saves and the key does not change.
  const canEdit = can('variable:update');
  const protectedWorkspace = useProtectedWorkspace();
  const variables = useQuery({ queryKey: queryKeys.variables, queryFn: variablesApi.list });
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.variables });
  const create = useMutation({
    mutationFn: () => variablesApi.create({ key: key.trim(), value }),
    onSuccess: () => {
      setKey('');
      setValue('');
      refresh();
      toast.success('Variable created');
    },
    onError: (error) => toast.error('Could not create the variable', errorMessage(error)),
  });
  const validKey = VARIABLE_KEY.test(key.trim());
  // a project variable is set and edited from its project's tab
  const workspaceVariables = (variables.data ?? []).filter((v) => !v.projectId);
  return (
    <Panel
      title="Variables"
      description="Workspace-wide values, read in expressions as $vars.name. A project's own variables are set on its Variables tab and win over these. Do not store secrets here; use credentials."
    >
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
      ) : !workspaceVariables.length ? (
        <EmptyState
          icon={<VariableIcon size={20} />}
          title="No variables yet"
          description="Add values that many workflows share, like a region or a base URL."
        />
      ) : (
        <ul>
          {workspaceVariables.map((v) => (
            <VariableRow
              key={`${v.id}:${v.key}:${v.value}`}
              variable={v}
              onSaved={refresh}
              readOnly={!canEdit}
              keyLocked={protectedWorkspace}
              canDelete={can('variable:delete')}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
