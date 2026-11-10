/**
 * Settings > API keys: the caller's public API keys (P6-21: expiry on create, edit, rotate, revoke, and an
 * "All keys" tab for `apiKey:manage` with the owner and label filters).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { apiKeysApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { ApiKey } from '../../api/types';
import { ApiKeyScopesField } from '../../components/settings/ApiKeyScopesField';
import { Button, IconButton } from '../../components/ui/Button';
import { confirmDialog, Dialog } from '../../components/ui/Dialog';
import { FormField, Select, TextInput } from '../../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../../components/ui/misc';
import { Tabs } from '../../components/ui/Tabs';
import { formatRelative } from '../../lib/format';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Panel } from './Panel';

type ExpiryChoice = 'none' | '7' | '30' | '60' | '90' | 'custom';
const EXPIRY_CHOICES: Array<{ value: ExpiryChoice; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
  { value: 'custom', label: 'Custom date' },
  { value: 'none', label: 'No expiration' },
];
const DAY_MS = 86_400_000;

/** unix seconds for the choice, undefined when the key never expires, null when a custom date is not usable */
function expiryFor(choice: ExpiryChoice, customDate: string): number | undefined | null {
  if (choice === 'none') return undefined;
  if (choice === 'custom') {
    const at = new Date(`${customDate}T23:59:59`).getTime();
    return customDate && Number.isFinite(at) && at > Date.now() ? Math.floor(at / 1000) : null;
  }
  return Math.floor((Date.now() + Number(choice) * DAY_MS) / 1000);
}

function expiryText(key: ApiKey): string {
  if (typeof key.expiresAt !== 'number') return 'never expires';
  const at = key.expiresAt * 1000;
  return at <= Date.now() ? `expired ${formatRelative(at)}` : `expires ${formatRelative(at)}`;
}

const isExpired = (key: ApiKey) => typeof key.expiresAt === 'number' && key.expiresAt * 1000 <= Date.now();

function EditKeyDialog({ keyRow, onClose }: { keyRow: ApiKey; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(keyRow.name);
  const [scopes, setScopes] = useState<string[]>(keyRow.scopes ?? []);
  const [onlyPicked, setOnlyPicked] = useState((keyRow.scopes ?? []).length > 0);
  const save = useMutation({
    mutationFn: () => apiKeysApi.update(keyRow.id, { name: name.trim(), scopes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
      toast.success('API key updated');
      onClose();
    },
    onError: (error) => toast.error('Could not update the key', errorMessage(error)),
  });
  const blocked = !name.trim() || (onlyPicked && scopes.length === 0);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit “${keyRow.name}”`}
      description="The secret stays the same. Rotate the key to get a new one."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={blocked} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Key name">
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <ApiKeyScopesField
          value={scopes}
          onChange={setScopes}
          onModeChange={setOnlyPicked}
          disabled={save.isPending}
        />
      </div>
    </Dialog>
  );
}

function KeyRow({
  row,
  showOwner,
  onEdit,
  onRotate,
  onRemove,
}: {
  row: ApiKey;
  showOwner: boolean;
  onEdit?: () => void;
  onRotate?: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{row.name}</span>
        <span className="block text-xs text-ink-3">
          {showOwner && row.ownerName ? <span>{row.ownerName} · </span> : null}
          {row.prefix ? <code>wfk_{row.prefix}_…</code> : null}{' '}
          {row.lastUsedAt ? `used ${formatRelative(row.lastUsedAt)}` : 'never used'} · {expiryText(row)}
        </span>
      </span>
      {onEdit && (
        <IconButton label={`Edit ${row.name}`} size="sm" onClick={onEdit}>
          <Pencil size={14} />
        </IconButton>
      )}
      {onRotate && (
        <IconButton label={`Rotate ${row.name}`} size="sm" onClick={onRotate} disabled={isExpired(row)}>
          <RefreshCw size={14} />
        </IconButton>
      )}
      <IconButton label={`Delete ${row.name}`} size="sm" onClick={onRemove}>
        <Trash2 size={14} />
      </IconButton>
    </li>
  );
}

export function ApiKeysSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canManage = can('apiKey:manage');
  const [tab, setTab] = useState<'mine' | 'all'>('mine');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const keys = useQuery({ queryKey: queryKeys.apiKeys, queryFn: apiKeysApi.list });
  const showAll = canManage && tab === 'all';
  const allKeys = useQuery({
    queryKey: queryKeys.apiKeysAll({ ownerId: ownerFilter, label: labelFilter }),
    queryFn: ({ signal }) =>
      apiKeysApi.listAll({ signal, ownerId: ownerFilter || undefined, label: labelFilter.trim() || undefined }),
    enabled: showAll,
  });
  // the owner menu lists the owners of every key
  const owners = useQuery({
    queryKey: queryKeys.apiKeysAll({ owners: true }),
    queryFn: ({ signal }) => apiKeysApi.listAll({ signal }),
    enabled: showAll,
  });
  const ownerOptions = [
    ...new Map(
      (owners.data ?? []).filter((k) => k.ownerId).map((k) => [k.ownerId as string, k.ownerName ?? k.ownerId]),
    ),
  ];
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<ExpiryChoice>('none');
  const [customDate, setCustomDate] = useState('');
  // empty means every scope
  const [scopes, setScopes] = useState<string[]>([]);
  // "only the scopes I pick" with none picked would make a key that can use every route
  const [onlyPicked, setOnlyPicked] = useState(false);
  // a new key starts on All scopes: the field is made again
  const [scopeFormKey, setScopeFormKey] = useState(0);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
  const create = useMutation({
    mutationFn: () => {
      const expiresAt = expiryFor(expiry, customDate);
      return apiKeysApi.create(name.trim(), scopes, expiresAt ?? undefined);
    },
    onSuccess: async (result) => {
      setCreated({ name: result.name, key: result.key });
      setCopied(false);
      setName('');
      setScopes([]);
      setOnlyPicked(false);
      setExpiry('none');
      setCustomDate('');
      setScopeFormKey((n) => n + 1);
      await refresh();
    },
    onError: (error) => toast.error('Could not create the key', errorMessage(error)),
  });
  const remove = async (row: ApiKey, byAdmin: boolean) => {
    const ok = await confirmDialog({
      title: `Delete “${row.name}”?`,
      description: byAdmin
        ? `${row.ownerName ?? 'The owner'} is told by mail. Anything using this key stops working right away.`
        : 'Anything using this key stops working right away.',
      confirmLabel: 'Delete key',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiKeysApi.remove(row.id);
      await refresh();
      toast.success('API key deleted');
    } catch (error) {
      toast.error('Could not delete the key', errorMessage(error));
    }
  };
  const rotate = async (row: ApiKey) => {
    const ok = await confirmDialog({
      title: `Rotate “${row.name}”?`,
      description: 'The key gets a new secret and the old one stops working right away.',
      confirmLabel: 'Rotate key',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const result = await apiKeysApi.rotate(row.id);
      setCreated({ name: result.name, key: result.key });
      setCopied(false);
      await refresh();
    } catch (error) {
      toast.error('Could not rotate the key', errorMessage(error));
    }
  };
  const customUnusable = expiry === 'custom' && expiryFor(expiry, customDate) === null;
  const blocked = !name.trim() || (onlyPicked && scopes.length === 0) || customUnusable;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) create.mutate();
  };
  const list = (rows: ApiKey[] | undefined, loading: boolean, error: unknown, mine: boolean) =>
    loading ? (
      <PageLoader />
    ) : error ? (
      <Callout tone="err" className="m-4">
        {errorMessage(error)}
      </Callout>
    ) : !rows?.length ? (
      <EmptyState
        icon={<KeyRound size={20} />}
        title="No API keys"
        description={
          mine ? 'Create one to automate this workspace from scripts and CI.' : 'No key matches these filters.'
        }
      />
    ) : (
      <ul>
        {rows.map((k) => (
          <KeyRow
            key={k.id}
            row={k}
            showOwner={!mine}
            onEdit={mine ? () => setEditing(k) : undefined}
            onRotate={mine ? () => void rotate(k) : undefined}
            onRemove={() => void remove(k, !mine)}
          />
        ))}
      </ul>
    );
  return (
    <Panel
      title="API keys"
      description="Use a key in the X-API-KEY header to call the public API at /api/v1."
    >
      {canManage && (
        <div className="border-b border-line px-5 pt-3">
          <Tabs
            label="API key lists"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'mine', label: 'My keys' },
              { value: 'all', label: 'All keys' },
            ]}
          />
        </div>
      )}
      {!showAll ? (
        <>
          <form onSubmit={submit} className="flex flex-col gap-3 border-b border-line px-5 py-4">
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="New key name" className="min-w-48 flex-1">
                {(id) => (
                  <TextInput
                    id={id}
                    placeholder="Deploy pipeline"
                    maxLength={50}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </FormField>
              <FormField label="Expiration">
                {(id) => (
                  <Select id={id} value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
                    {EXPIRY_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              {expiry === 'custom' && (
                <FormField label="Expires on">
                  {(id) => (
                    <TextInput
                      id={id}
                      type="date"
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                  )}
                </FormField>
              )}
              <Button
                type="submit"
                variant="primary"
                icon={<Plus size={15} />}
                loading={create.isPending}
                disabled={blocked}
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
          {list(keys.data, keys.isLoading, keys.error, true)}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-4">
            <FormField label="Owner" className="min-w-48">
              {(id) => (
                <Select id={id} value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="">Everyone</option>
                  {ownerOptions.map(([ownerId, ownerName]) => (
                    <option key={ownerId} value={ownerId}>
                      {ownerName}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Label" className="min-w-48">
              {(id) => (
                <TextInput
                  id={id}
                  placeholder="Search by label"
                  value={labelFilter}
                  onChange={(e) => setLabelFilter(e.target.value)}
                />
              )}
            </FormField>
          </div>
          {list(allKeys.data, allKeys.isLoading, allKeys.error, false)}
        </>
      )}
      {editing && <EditKeyDialog keyRow={editing} onClose={() => setEditing(null)} />}
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
