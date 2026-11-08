/**
 * P5-71 (L8): first setup on `/assistant` for an owner or admin with no model: step model, step search (Skip).
 * There is no sandbox step. `AssistantModelForm` is shared with Settings > Assistant.
 *
 * The model step saves on its own; the page keeps showing the wizard until the last step, because the page
 * reads `features.assistant.modelSet` and the settings are refreshed only when the wizard ends.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeTypeDescription } from '@workflow/workflow';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { assistantApi } from '../../api/endpoints';
import { queryKeys, useCredentials, useCredentialTypes, useNodeTypes } from '../../api/queries';
import type { AssistantSettingsDTO } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { FormField, Select, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';

const MODEL_PREFIX = 'ai.lmChat';
const MODEL_OUTPUT = 'ai_languageModel';
const MODEL_PARAMETERS = ['model', 'modelName'];

/** the credential types a web search key can be */
export const SEARCH_CREDENTIAL_TYPES = ['braveSearchApi', 'searXngApi'];

/** a chat model node the Assistant can use (the server's `isBuilderModelNode` rule) */
function isChatModelNode(description: NodeTypeDescription): boolean {
  if (!description.name.startsWith(MODEL_PREFIX) || !Array.isArray(description.outputs)) return false;
  return description.outputs.some((port) =>
    typeof port === 'string' ? port === MODEL_OUTPUT : port?.type === MODEL_OUTPUT,
  );
}

/** the model id a node suggests: the default of its `model` / `modelName` parameter */
function suggestedModel(description: NodeTypeDescription | undefined): string {
  const prop = description?.properties.find((p) => MODEL_PARAMETERS.includes(p.name));
  return typeof prop?.default === 'string' ? prop.default : '';
}

interface ModelDraft {
  nodeType: string;
  credentialId: string;
  model: string;
}

/** model provider, credential and model id; Save sends them to PATCH /assistant/settings */
export function AssistantModelForm({
  initial,
  submitLabel = 'Save',
  onSaved,
}: {
  initial?: Pick<AssistantSettingsDTO, 'nodeType' | 'credentialId' | 'model'>;
  submitLabel?: string;
  onSaved: (settings: AssistantSettingsDTO) => void | Promise<void>;
}) {
  const nodeTypes = useNodeTypes();
  const credentialTypes = useCredentialTypes();
  const credentials = useCredentials();
  const [draft, setDraft] = useState<ModelDraft>({
    nodeType: initial?.nodeType ?? '',
    credentialId: initial?.credentialId ?? '',
    model: initial?.model ?? '',
  });
  const [touched, setTouched] = useState(false);

  // the saved setup can arrive after the first render: take it until the admin edits
  useEffect(() => {
    if (!touched) {
      setDraft({
        nodeType: initial?.nodeType ?? '',
        credentialId: initial?.credentialId ?? '',
        model: initial?.model ?? '',
      });
    }
  }, [initial?.nodeType, initial?.credentialId, initial?.model, touched]);

  const models = useMemo(
    () => nodeTypes.list.filter(isChatModelNode).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [nodeTypes.list],
  );
  const selected = nodeTypes.get(draft.nodeType);
  /** credentials whose type fits a credential slot of the chosen node (or extends one) */
  const usable = useMemo(() => {
    const slots = (selected?.credentials ?? []).map((c) => c.name);
    const fits = (type: string, seen = new Set<string>()): boolean => {
      if (slots.includes(type)) return true;
      if (seen.has(type)) return false;
      seen.add(type);
      return (credentialTypes.get(type)?.extends ?? []).some((parent) => fits(parent, seen));
    };
    const all = credentials.data ?? [];
    return slots.length ? all.filter((c) => fits(c.type)) : all;
  }, [selected, credentials.data, credentialTypes]);

  const change = (patch: Partial<ModelDraft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = useMutation({
    mutationFn: () =>
      assistantApi.patchSettings({
        nodeType: draft.nodeType,
        credentialId: draft.credentialId,
        model: draft.model.trim(),
      }),
    onSuccess: async (settings) => {
      setTouched(false);
      await onSaved(settings);
    },
    onError: (error) => toast.error("Couldn't save the model", errorMessage(error)),
  });

  const missing = !draft.nodeType
    ? 'Choose a model provider'
    : !draft.credentialId
      ? 'Choose a credential'
      : !draft.model.trim()
        ? 'Enter a model'
        : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!missing) save.mutate();
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Assistant model">
      <FormField label="Model provider" required hint="A chat model node that can call tools.">
        {(id) => (
          <Select
            id={id}
            value={draft.nodeType}
            onChange={(e) =>
              change({
                nodeType: e.target.value,
                credentialId: '',
                model: suggestedModel(nodeTypes.get(e.target.value)),
              })
            }
          >
            <option value="">Choose a provider</option>
            {models.map((d) => (
              <option key={d.name} value={d.name}>
                {d.displayName}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label="Credential"
        required
        hint={
          draft.nodeType && !usable.length ? (
            <>
              No credential of this provider yet. Create one on the{' '}
              <Link to="/credentials" className="font-semibold text-brand hover:underline">
                Credentials page
              </Link>{' '}
              first.
            </>
          ) : (
            'The Assistant signs its model requests with this credential.'
          )
        }
      >
        {(id) => (
          <Select
            id={id}
            value={draft.credentialId}
            disabled={!draft.nodeType}
            onChange={(e) => change({ credentialId: e.target.value })}
          >
            <option value="">Choose a credential</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Model" required hint="The model id, for example gpt-4o-mini.">
        {(id) => (
          <TextInput
            id={id}
            value={draft.model}
            disabled={!draft.nodeType}
            placeholder={suggestedModel(selected) || 'Model id'}
            onChange={(e) => change({ model: e.target.value })}
          />
        )}
      </FormField>
      <div className="flex items-center justify-end gap-3">
        {missing && touched && <p className="text-xs text-ink-2">{missing}</p>}
        <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(missing)}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** the workspace's web search keys (Brave Search or SearXNG), for a select */
export function useSearchCredentials() {
  const credentials = useCredentials();
  const list = useMemo(
    () => (credentials.data ?? []).filter((c) => SEARCH_CREDENTIAL_TYPES.includes(c.type)),
    [credentials.data],
  );
  return { list, isLoading: credentials.isLoading };
}

type Step = 'model' | 'search';

export function AssistantWizard() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('model');
  const [searchId, setSearchId] = useState('');
  const search = useSearchCredentials();

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    await queryClient.invalidateQueries({ queryKey: queryKeys.assistantSettings });
  };

  const saveSearch = useMutation({
    mutationFn: (body: { searchCredentialId: string } | { searchDisabled: true }) =>
      assistantApi.patchSettings(body),
    onSuccess: finish,
    onError: (error) => toast.error("Couldn't save the search setting", errorMessage(error)),
  });

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-line bg-surface p-5">
      <div>
        <p className="text-xs font-semibold uppercase text-ink-2">
          {step === 'model' ? 'Step 1 of 2' : 'Step 2 of 2'}
        </p>
        <h2 className="mt-1 font-display text-lg font-semibold">
          {step === 'model' ? 'Choose a model' : 'Add web search'}
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          {step === 'model'
            ? 'The Assistant runs on your own credential. Requests go from this server to the provider you choose.'
            : 'With a search key the Assistant can look things up on the web. You can skip this and add one later in Settings.'}
        </p>
      </div>

      {step === 'model' ? (
        <AssistantModelForm submitLabel="Next" onSaved={() => setStep('search')} />
      ) : (
        <form
          className="flex flex-col gap-4"
          aria-label="Assistant web search"
          onSubmit={(event) => {
            event.preventDefault();
            if (searchId) saveSearch.mutate({ searchCredentialId: searchId });
          }}
        >
          <FormField
            label="Search key"
            hint={
              search.list.length || search.isLoading ? (
                'A Brave Search or SearXNG credential.'
              ) : (
                <>
                  No search credential yet. Create a Brave Search or SearXNG one on the{' '}
                  <Link to="/credentials" className="font-semibold text-brand hover:underline">
                    Credentials page
                  </Link>
                  , or skip.
                </>
              )
            }
          >
            {(id) => (
              <Select id={id} value={searchId} onChange={(e) => setSearchId(e.target.value)}>
                <option value="">Choose a credential</option>
                {search.list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {saveSearch.isError && <Callout tone="err">{errorMessage(saveSearch.error)}</Callout>}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saveSearch.isPending}
              onClick={() => saveSearch.mutate({ searchDisabled: true })}
            >
              Skip
            </Button>
            <Button type="submit" variant="primary" loading={saveSearch.isPending} disabled={!searchId}>
              Finish
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
