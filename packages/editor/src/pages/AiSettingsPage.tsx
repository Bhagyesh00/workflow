/**
 * P5-09: Settings > AI (admins): the chat model node, credential and model the builder uses, and
 * whether parameter values may be sent. Saved with PATCH /settings (`ai`); the server checks that the
 * credential is this workspace's and the node a chat model. Below admin there is no nav link (C0e);
 * opened directly, the page says who can change it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeTypeDescription } from '@workflow/workflow';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../api/client';
import { settingsApi } from '../api/endpoints';
import {
  aiBuilderFeatureOf,
  queryKeys,
  useCredentials,
  useCredentialTypes,
  useMe,
  useNodeTypes,
  useSettings,
} from '../api/queries';
import type { TenantAiSettings } from '../api/types';
import { Button } from '../components/ui/Button';
import { FormField, Select, Switch, TextInput } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { canWith } from '../lib/permissions';
import { toast } from '../stores/ui-store';

const MODEL_PREFIX = 'ai.lmChat';
const MODEL_OUTPUT = 'ai_languageModel';
const MODEL_PARAMETERS = ['model', 'modelName'];

/** a chat model node the builder can use (the server's `isBuilderModelNode` rule) */
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

interface Draft {
  nodeType: string;
  credentialId: string;
  model: string;
  allowSendingParameterValues: boolean;
}

function draftOf(ai: TenantAiSettings | undefined): Draft {
  return {
    nodeType: ai?.nodeType ?? '',
    credentialId: ai?.credentialId ?? '',
    model: ai?.model ?? '',
    allowSendingParameterValues: ai?.allowSendingParameterValues !== false,
  };
}

export function AiSettingsPage() {
  const me = useMe();
  const settings = useSettings();
  const nodeTypes = useNodeTypes();
  const credentialTypes = useCredentialTypes();
  const credentials = useCredentials();
  const queryClient = useQueryClient();
  const isAdmin = canWith(me.data, 'aiAssistant:manage');
  const feature = aiBuilderFeatureOf(settings);
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings.ai));
  const [touched, setTouched] = useState(false);

  // the saved setup arrives after the first render: take it until the admin edits
  useEffect(() => {
    if (!touched) setDraft(draftOf(settings.ai));
  }, [settings.ai, touched]);

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

  const change = (patch: Partial<Draft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = useMutation({
    mutationFn: (ai: TenantAiSettings) => settingsApi.update({ ai }),
    onSuccess: async () => {
      setTouched(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success('AI settings saved');
    },
    onError: (error) => toast.error("Couldn't save the AI settings", errorMessage(error)),
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
    if (missing) return;
    save.mutate({
      nodeType: draft.nodeType,
      credentialId: draft.credentialId,
      model: draft.model.trim(),
      allowSendingParameterValues: draft.allowSendingParameterValues,
    });
  };

  if (me.isLoading) return <PageLoader />;
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">AI</h2>
        <p className="mt-1 text-sm text-ink-2">
          The model the AI workflow builder uses in this workspace. It runs on your own credential: requests
          go from this server to the provider you choose.
        </p>
      </div>
      {!isAdmin ? (
        <Callout>Only admins can change the AI settings.</Callout>
      ) : (
        <>
          {!feature.enabled && (
            <Callout tone="warn" title="The AI builder is off on this server">
              Your settings are kept, but nobody can build with AI until the server sets AI_ENABLED to true.
            </Callout>
          )}
          <form
            className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"
            onSubmit={submit}
            aria-label="AI settings"
          >
            <FormField label="Model provider" required hint="A chat model node that can call tools.">
              {(id) => (
                <Select
                  id={id}
                  value={draft.nodeType}
                  onChange={(e) => {
                    const next = nodeTypes.get(e.target.value);
                    change({
                      nodeType: e.target.value,
                      credentialId: '',
                      model: suggestedModel(next),
                    });
                  }}
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
                draft.nodeType && !usable.length
                  ? 'No credential of this provider yet. Create one on the Credentials page first.'
                  : 'The builder signs its model requests with this credential.'
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
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Send parameter values</p>
                <p className="mt-1 text-xs text-ink-2">
                  When off, the model sees only the structure of your workflows and run data, never the
                  values. Secrets are always removed.
                </p>
              </div>
              <Switch
                label="Send parameter values"
                checked={draft.allowSendingParameterValues}
                onChange={(next) => change({ allowSendingParameterValues: next })}
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              {missing && touched && <p className="text-xs text-ink-2">{missing}</p>}
              <Button type="submit" variant="primary" loading={save.isPending} disabled={Boolean(missing)}>
                Save
              </Button>
            </div>
          </form>
          <p className="text-sm text-ink-2" data-testid="ai-setup-state">
            {feature.setup ? 'The builder has a model.' : 'No model is set yet.'}
          </p>
        </>
      )}
    </section>
  );
}
