/**
 * P6-76 (L6): connect a Git repository. SSH shows the workspace's public key (copy it, or regenerate it after a
 * confirm) to add as a deploy key on the Git host; HTTPS takes a user name and an access token. The token is a
 * write-only field: it is sent once, never shown again and cleared from the page as soon as the request is
 * sent. The private key never reaches the editor.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { sourceControlApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { SourceControlKeyType, SourceControlPreferences } from '../../api/types';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { FormField, Select, TextArea, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';

export interface ConnectionFormProps {
  /** GET /source-control/preferences (the public key, key type and last URL, while not connected) */
  preferences: SourceControlPreferences;
  /** the answer of a connect that listed the branches */
  onConnected(preferences: SourceControlPreferences): void;
}

export function ConnectionForm({ preferences, onConnected }: ConnectionFormProps) {
  const queryClient = useQueryClient();
  const [connectionType, setConnectionType] = useState<'ssh' | 'https'>(preferences.connectionType ?? 'ssh');
  const [repositoryUrl, setRepositoryUrl] = useState(preferences.repositoryUrl ?? '');
  const [keyType, setKeyType] = useState<SourceControlKeyType>(preferences.keyGeneratorType ?? 'ed25519');
  const [username, setUsername] = useState(preferences.httpsUsername ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connect = useMutation({
    // a token that was typed leaves the mutation cache with the request
    gcTime: 0,
    mutationFn: () =>
      sourceControlApi.connect({
        connectionType,
        repositoryUrl: repositoryUrl.trim(),
        ...(connectionType === 'ssh'
          ? { keyGeneratorType: keyType }
          : {
              ...(username.trim() ? { httpsUsername: username.trim() } : {}),
              ...(token ? { httpsPassword: token } : {}),
            }),
      }),
    onSuccess: (result) => {
      setToken('');
      setError(null);
      onConnected(result);
    },
    onError: (e) => {
      setToken('');
      setError(errorMessage(e));
    },
  });

  const regenerate = useMutation({
    mutationFn: () => sourceControlApi.generateKeyPair(keyType),
    onSuccess: async () => {
      setCopied(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sourceControlPreferences });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const askRegenerate = async () => {
    const ok = await confirmDialog({
      title: 'Regenerate the SSH key?',
      description: 'The current key stops working. Add the new public key to your Git host as a deploy key.',
      confirmLabel: 'Regenerate',
      tone: 'danger',
    });
    if (ok) regenerate.mutate();
  };

  // a token is never sent over plain http://, so such a remote is connected without one (a public mirror, a LAN host)
  const plainHttp = /^http:\/\//i.test(repositoryUrl.trim());
  const ready =
    repositoryUrl.trim() !== '' &&
    (connectionType === 'ssh' || plainHttp || (username.trim() !== '' && token !== ''));

  return (
    <form
      className="flex flex-col gap-4 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !connect.isPending) connect.mutate();
      }}
    >
      <FormField label="Connection type">
        {(id) => (
          <Select
            id={id}
            value={connectionType}
            onChange={(e) => setConnectionType(e.target.value === 'https' ? 'https' : 'ssh')}
          >
            <option value="ssh">SSH</option>
            <option value="https">HTTPS</option>
          </Select>
        )}
      </FormField>
      <FormField
        label="Repository URL"
        hint={
          connectionType === 'ssh'
            ? 'For example git@github.com:team/workflows.git or ssh://git@host/team/workflows.git'
            : 'For example https://github.com/team/workflows.git'
        }
      >
        {(id) => (
          <TextInput
            id={id}
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </FormField>
      {connectionType === 'ssh' ? (
        <>
          <FormField label="Key type">
            {(id) => (
              <Select
                id={id}
                value={keyType}
                onChange={(e) => setKeyType(e.target.value === 'rsa' ? 'rsa' : 'ed25519')}
              >
                <option value="ed25519">ED25519</option>
                <option value="rsa">RSA</option>
              </Select>
            )}
          </FormField>
          {preferences.publicKey && (
            <FormField
              label="Public key"
              hint="Add this key to your Git host as a deploy key with write access."
            >
              {(id) => (
                <div className="flex items-start gap-2">
                  <TextArea
                    id={id}
                    readOnly
                    rows={3}
                    value={preferences.publicKey}
                    className="flex-1 font-mono text-xs"
                  />
                  <div className="flex flex-col gap-1.5">
                    <Button
                      size="sm"
                      aria-label="Copy public key"
                      icon={copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(preferences.publicKey ?? '')
                          .then(() => setCopied(true))
                          .catch(() => undefined)
                      }
                    >
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      icon={<RefreshCw size={13} />}
                      loading={regenerate.isPending}
                      onClick={() => void askRegenerate()}
                    >
                      Regenerate key
                    </Button>
                  </div>
                </div>
              )}
            </FormField>
          )}
        </>
      ) : (
        <>
          <FormField label="Username">
            {(id) => (
              <TextInput
                id={id}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField
            label="Access token"
            hint="Write only: it is sent to the server once and never shown again. It is never sent over plain http://."
          >
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="new-password"
              />
            )}
          </FormField>
        </>
      )}
      {error && <Callout tone="err">{error}</Callout>}
      <div>
        <Button type="submit" variant="primary" loading={connect.isPending} disabled={!ready}>
          Connect
        </Button>
      </div>
    </form>
  );
}
