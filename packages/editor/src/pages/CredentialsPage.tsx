/** Credentials: list, create (type picker), edit, delete. Secrets are never shown. */
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../api/client';
import { credentialsApi } from '../api/endpoints';
import { useCredentials, useCredentialTypes } from '../api/queries';
import { CredentialModal } from '../components/credentials/CredentialModal';
import { CredentialTypePicker } from '../components/credentials/CredentialTypePicker';
import { NodeIcon } from '../components/NodeIcon';
import { Button, IconButton } from '../components/ui/Button';
import { confirmDialog } from '../components/ui/Dialog';
import { Menu } from '../components/ui/Menu';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { formatRelative } from '../lib/format';
import { toast } from '../stores/ui-store';

export function CredentialsPage() {
  const credentials = useCredentials();
  const types = useCredentialTypes();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [picker, setPicker] = useState(false);
  const [modal, setModal] = useState<{ type?: string; id?: string } | null>(null);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (credentials.data ?? []).filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (types.get(c.type)?.displayName ?? c.type).toLowerCase().includes(q),
    );
  }, [credentials.data, search, types]);

  const remove = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      description: 'Workflows that use it will fail until you pick another credential.',
      confirmLabel: 'Delete credential',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await credentialsApi.remove(id);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      toast.success('Credential deleted');
    } catch (error) {
      toast.error('Could not delete the credential', errorMessage(error));
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Credentials</h1>
          <p className="mt-1 text-sm text-ink-2">
            Accounts and keys your workflows connect with. Secrets are encrypted and never shown again.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setPicker(true)}>
          Add credential
        </Button>
      </header>
      <div className="relative max-w-md">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
        />
        <input
          className="wf-field pl-9"
          placeholder="Search credentials"
          aria-label="Search credentials"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <section
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        aria-label="Credential list"
      >
        {credentials.isLoading ? (
          <PageLoader />
        ) : credentials.error ? (
          <Callout tone="err" className="m-4" title="Could not load credentials">
            {errorMessage(credentials.error)}
          </Callout>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<KeyRound size={20} />}
            title={search ? 'No credentials match' : 'No credentials yet'}
            description={
              search ? undefined : 'Add the accounts your workflows need, then pick them in each node.'
            }
            action={
              !search && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setPicker(true)}>
                  Add credential
                </Button>
              )
            }
          />
        ) : (
          <ul>
            {list.map((c) => {
              const type = types.get(c.type);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-b-0 hover:bg-surface-2"
                >
                  <span className="grid size-9 place-items-center rounded-lg bg-surface-3 text-ink-2">
                    {type?.icon ? (
                      <NodeIcon
                        description={{ name: type.name, displayName: type.displayName, icon: type.icon }}
                        size={17}
                      />
                    ) : (
                      <KeyRound size={16} />
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setModal({ id: c.id })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate font-semibold text-ink hover:text-brand">{c.name}</span>
                    <span className="block text-xs text-ink-3">
                      {type?.displayName ?? c.type}, updated {formatRelative(c.updatedAt)}
                    </span>
                  </button>
                  <Menu
                    trigger={(t) => (
                      <IconButton
                        label={`Actions for ${c.name}`}
                        size="sm"
                        onClick={t.toggle}
                        aria-expanded={t['aria-expanded']}
                        aria-haspopup="menu"
                      >
                        <MoreHorizontal size={15} />
                      </IconButton>
                    )}
                    items={[
                      {
                        key: 'edit',
                        label: 'Edit',
                        icon: <Pencil size={14} />,
                        onSelect: () => setModal({ id: c.id }),
                      },
                      {
                        key: 'delete',
                        label: 'Delete',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => void remove(c.id, c.name),
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <CredentialTypePicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(type) => {
          setPicker(false);
          setModal({ type });
        }}
      />
      <CredentialModal
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        credentialId={modal?.id ?? null}
        type={modal?.type ?? null}
      />
    </div>
  );
}
