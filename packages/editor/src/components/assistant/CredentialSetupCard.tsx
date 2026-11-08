/**
 * P5-69 (L6): `setup_credentials`: opens the existing credential dialog for the type; the model never sees data.
 *
 * The person picks a credential of the type this workspace already has, or creates one in `CredentialModal` (the
 * same dialog as everywhere else), or skips. Only the chosen id goes to the server; the server checks it is this
 * workspace's and of the type, and gives the Assistant its id, name and type. The reason is the Assistant's own
 * words and sits apart, as text.
 */
import { KeyRound } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import { useCredentials, useCredentialTypes } from '../../api/queries';
import type { AssistantConfirmationOf } from '../../api/types';
import { answerConfirmation } from '../../features/assistant/confirm-actions';
import { toast } from '../../stores/ui-store';
import { CredentialModal } from '../credentials/CredentialModal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';

export interface CredentialSetupCardProps {
  confirmation: AssistantConfirmationOf<'credential'>;
}

type Choice = 'use' | 'create' | 'skip';

export function CredentialSetupCard({ confirmation }: CredentialSetupCardProps) {
  const { requestId, title, details, expiresAt } = confirmation;
  const credentialType = details?.credentialType ?? '';
  const types = useCredentialTypes();
  const list = useCredentials(credentialType);
  const selectId = useId();
  const [picked, setPicked] = useState<string>('');
  const [modalOpen, setModalOpen] = useState(false);
  const saved = useRef<string | null>(null);
  const [busy, setBusy] = useState<Choice | null>(null);
  const [sent, setSent] = useState(false);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  const disabled = busy !== null || sent || expired;

  const typeName = details?.displayName || types.get(credentialType)?.displayName || credentialType;
  const existing = list.data ?? [];
  const selected = picked || existing[0]?.id || '';

  const answer = async (choice: Choice, credentialId: string | null) => {
    setBusy(choice);
    try {
      await answerConfirmation(requestId, { kind: 'credential', credentialId });
      setSent(true);
    } catch (error) {
      const reason =
        error instanceof ApiError && error.status === 404
          ? 'This request is no longer open.'
          : errorMessage(error);
      toast.error("Couldn't send your answer", reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset
      aria-label={`Set up a credential: ${typeName}`}
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <KeyRound size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 break-words">
          {title}
          {': '}
          <strong className="font-semibold text-ink">{typeName}</strong>
        </span>
      </p>
      <p className="m-0 text-xs text-ink-2">
        The Assistant never sees what you enter here: it only learns which credential you picked.
      </p>

      {details?.reason ? (
        <div className="rounded border border-line px-2 py-1 text-sm">
          <p className="text-xs font-semibold text-ink-2">The Assistant says</p>
          <p className="m-0 whitespace-pre-wrap break-words text-ink-2">{details.reason}</p>
        </div>
      ) : null}

      {existing.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-semibold text-ink">
            Credential to use
          </label>
          <Select
            id={selectId}
            value={selected}
            disabled={disabled}
            onChange={(event) => setPicked(event.target.value)}
          >
            {existing.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {list.isError && <p className="m-0 text-xs text-err">Couldn't load the credentials of this type.</p>}

      <div className="flex flex-wrap items-center gap-2">
        {existing.length > 0 && (
          <Button
            variant="primary"
            disabled={disabled || !selected}
            loading={busy === 'use'}
            onClick={() => void answer('use', selected)}
          >
            Use this credential
          </Button>
        )}
        <Button
          variant={existing.length > 0 ? 'secondary' : 'primary'}
          disabled={disabled}
          loading={busy === 'create'}
          onClick={() => {
            saved.current = null;
            setModalOpen(true);
          }}
        >
          Create a new one
        </Button>
        <Button disabled={disabled} loading={busy === 'skip'} onClick={() => void answer('skip', null)}>
          Skip
        </Button>
        {expired && <span className="text-xs text-ink-2">This request timed out</span>}
      </div>

      <CredentialModal
        open={modalOpen}
        type={modalOpen ? credentialType : null}
        onSaved={(credential) => {
          saved.current = credential.id;
        }}
        onClose={() => {
          setModalOpen(false);
          // a new credential answers the card once its dialog closes (OAuth connects before that)
          const id = saved.current;
          saved.current = null;
          if (id) void answer('create', id);
        }}
      />
    </fieldset>
  );
}
