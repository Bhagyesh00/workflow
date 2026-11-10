/** Settings > API keys: the caller's public API keys. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { apiKeysApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import { ApiKeyScopesField } from '../../components/settings/ApiKeyScopesField';
import { Button, IconButton } from '../../components/ui/Button';
import { confirmDialog, Dialog } from '../../components/ui/Dialog';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../../components/ui/misc';
import { formatRelative } from '../../lib/format';
import { toast } from '../../stores/ui-store';
import { Panel } from './Panel';

export function ApiKeysSettingsPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: queryKeys.apiKeys, queryFn: apiKeysApi.list });
  const [name, setName] = useState('');
  // empty means every scope
  const [scopes, setScopes] = useState<string[]>([]);
  // "only the scopes I pick" with none picked would make a key that can use every route
  const [onlyPicked, setOnlyPicked] = useState(false);
  // a new key starts on All scopes: the field is made again
  const [scopeFormKey, setScopeFormKey] = useState(0);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => apiKeysApi.create(name.trim(), scopes),
    onSuccess: async (result) => {
      setCreated({ name: result.name, key: result.key });
      setCopied(false);
      setName('');
      setScopes([]);
      setOnlyPicked(false);
      setScopeFormKey((n) => n + 1);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
    onError: (error) => toast.error('Could not create the key', errorMessage(error)),
  });
  const remove = async (id: string, keyName: string) => {
    const ok = await confirmDialog({
      title: `Delete “${keyName}”?`,
      description: 'Anything using this key stops working right away.',
      confirmLabel: 'Delete key',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiKeysApi.remove(id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
      toast.success('API key deleted');
    } catch (error) {
      toast.error('Could not delete the key', errorMessage(error));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !(onlyPicked && !scopes.length)) create.mutate();
  };
  return (
    <Panel
      title="API keys"
      description="Use a key in the X-API-KEY header to call the public API at /api/v1."
    >
      <form onSubmit={submit} className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <div className="flex items-end gap-2">
          <FormField label="New key name" className="flex-1">
            {(id) => (
              <TextInput
                id={id}
                placeholder="Deploy pipeline"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} />}
            loading={create.isPending}
            disabled={!name.trim() || (onlyPicked && scopes.length === 0)}
          >
            Create key
          </Button>
        </div>
        <ApiKeyScopesField
          key={scopeFormKey}
          value={scopes}
          onChange={setScopes}
          onModeChange={setOnlyPicked}
          disabled={create.isPending}
        />
      </form>
      {keys.isLoading ? (
        <PageLoader />
      ) : keys.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(keys.error)}
        </Callout>
      ) : !keys.data?.length ? (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No API keys"
          description="Create one to automate this workspace from scripts and CI."
        />
      ) : (
        <ul>
          {keys.data.map((k) => (
            <li key={k.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{k.name}</span>
                <span className="block text-xs text-ink-3">
                  {k.prefix ? <code>wfk_{k.prefix}_…</code> : null}{' '}
                  {k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : 'never used'}
                </span>
              </span>
              <IconButton label={`Delete ${k.name}`} size="sm" onClick={() => void remove(k.id, k.name)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        title="Copy your new key"
        description="This is the only time the key is shown. Store it somewhere safe."
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I copied it
          </Button>
        }
      >
        {created && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 break-all text-xs" data-testid="new-api-key">
              {created.key}
            </code>
            <IconButton
              label="Copy key"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(created.key)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
            >
              {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
            </IconButton>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}
