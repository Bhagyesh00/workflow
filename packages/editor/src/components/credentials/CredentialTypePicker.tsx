import { KeyRound, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCredentialTypes } from '../../api/queries';
import { NodeIcon } from '../NodeIcon';
import { Dialog } from '../ui/Dialog';
import { EmptyState, PageLoader } from '../ui/misc';

export function CredentialTypePicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: string) => void;
}) {
  const types = useCredentialTypes();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return types.list
      .filter((t) => !q || t.displayName.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [types.list, search]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a credential"
      description="Choose the app or service to connect."
      size="md"
    >
      <div className="relative mb-3">
        <Search
          size={14}
          className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          aria-hidden="true"
        />
        <input
          className="wf-field pl-9"
          placeholder="Search apps and services"
          aria-label="Search credential types"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-autofocus
        />
      </div>
      {types.isLoading ? (
        <PageLoader />
      ) : filtered.length === 0 ? (
        <EmptyState icon={<KeyRound size={20} />} title="No matching credential types" />
      ) : (
        <ul className="wf-scroll -mx-1 max-h-[50vh] overflow-auto">
          {filtered.map((t) => (
            <li key={t.name}>
              <button
                type="button"
                onClick={() => onPick(t.name)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3"
              >
                <span className="grid size-8 place-items-center rounded-lg bg-surface-3 text-ink-2">
                  {t.icon ? (
                    <NodeIcon
                      description={{ name: t.name, displayName: t.displayName, icon: t.icon }}
                      size={16}
                    />
                  ) : (
                    <KeyRound size={15} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{t.displayName}</span>
                  <span className="block truncate text-xs text-ink-3">
                    {t.isOAuth2
                      ? 'OAuth2 sign-in'
                      : t.properties.some((p) => p.typeOptions?.password)
                        ? 'API key or password'
                        : 'Connection settings'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
