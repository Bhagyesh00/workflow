/**
 * P6-13: the OpenID Connect settings form: discovery URL, client ID and secret (blank on read; a blank on save
 * keeps the stored one), prompt, authentication context class references, extra scopes, logout at the identity
 * provider and "email must be verified", with the redirect URL to give the provider.
 */
import { type FormEvent, useEffect, useState } from 'react';
import type { OidcConfig, OidcConfigBody, OidcPrompt } from '../../api/types';
import { Button } from '../ui/Button';
import { Checkbox, FormField, Select, TextInput } from '../ui/Field';
import { CopyField } from './CopyField';

const PROMPTS: { value: OidcPrompt; label: string }[] = [
  { value: 'select_account', label: 'Select account' },
  { value: 'login', label: 'Login' },
  { value: 'consent', label: 'Consent' },
  { value: 'none', label: 'None' },
  { value: 'create', label: 'Create' },
];

interface Draft {
  discoveryEndpoint: string;
  clientId: string;
  prompt: OidcPrompt;
  /** comma separated */
  acr: string;
  additionalScopes: string;
  rpInitiatedLogoutEnabled: boolean;
  emailVerifiedRequired: boolean;
}

function draftOf(config: OidcConfig): Draft {
  return {
    discoveryEndpoint: config.discoveryEndpoint,
    clientId: config.clientId,
    prompt: config.prompt,
    acr: config.authenticationContextClassReference.join(', '),
    additionalScopes: config.additionalScopes,
    rpInitiatedLogoutEnabled: config.rpInitiatedLogoutEnabled,
    emailVerifiedRequired: config.emailVerifiedRequired,
  };
}

export interface OidcFormProps {
  config: OidcConfig;
  saving: boolean;
  testing: boolean;
  error: string | null;
  onSave(body: OidcConfigBody): void;
  onTest(): void;
  onDirtyChange?(dirty: boolean): void;
}

export function OidcForm({ config, saving, testing, error, onSave, onTest, onDirtyChange }: OidcFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(config));
  const [secret, setSecret] = useState('');
  useEffect(() => {
    setDraft(draftOf(config));
    setSecret('');
  }, [config]);
  const dirty = secret !== '' || JSON.stringify(draft) !== JSON.stringify(draftOf(config));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const hasConfig = Boolean(config.clientId && config.discoveryEndpoint);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      discoveryEndpoint: draft.discoveryEndpoint.trim(),
      clientId: draft.clientId.trim(),
      ...(secret ? { clientSecret: secret } : {}),
      prompt: draft.prompt,
      authenticationContextClassReference: draft.acr
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      additionalScopes: draft.additionalScopes.trim(),
      rpInitiatedLogoutEnabled: draft.rpInitiatedLogoutEnabled,
      emailVerifiedRequired: draft.emailVerifiedRequired,
    });
  };

  return (
    <form onSubmit={submit} aria-label="OIDC settings" className="flex flex-col gap-4">
      {config.callbackUrl && (
        <CopyField
          label="Redirect URL"
          value={config.callbackUrl}
          hint="Give this to your identity provider as the allowed redirect."
        />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Discovery URL" hint="The provider's .well-known/openid-configuration address.">
          {(id) => (
            <TextInput
              id={id}
              value={draft.discoveryEndpoint}
              placeholder="https://idp.example.com/.well-known/openid-configuration"
              onChange={(e) => set('discoveryEndpoint', e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Client ID">
          {(id) => (
            <TextInput
              id={id}
              value={draft.clientId}
              autoComplete="off"
              onChange={(e) => set('clientId', e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Client secret"
          hint={
            hasConfig
              ? 'Stored encrypted and never shown again. Leave blank to keep the saved one.'
              : 'Stored encrypted and never shown again.'
          }
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Prompt" hint="What the provider asks the person on each sign-in.">
          {(id) => (
            <Select
              id={id}
              value={draft.prompt}
              onChange={(e) => set('prompt', e.target.value as OidcPrompt)}
            >
              {PROMPTS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Authentication context class references" hint="Optional, separated by commas.">
          {(id) => <TextInput id={id} value={draft.acr} onChange={(e) => set('acr', e.target.value)} />}
        </FormField>
        <FormField label="Additional scopes" hint="Separated by spaces, added to openid, email and profile.">
          {(id) => (
            <TextInput
              id={id}
              value={draft.additionalScopes}
              onChange={(e) => set('additionalScopes', e.target.value)}
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-col gap-2">
        <Checkbox
          label="Sign people out of the identity provider too"
          checked={draft.rpInitiatedLogoutEnabled}
          onChange={(e) => set('rpInitiatedLogoutEnabled', e.target.checked)}
        />
        <Checkbox
          label="Refuse sign-ins whose email the identity provider has not verified"
          checked={draft.emailVerifiedRequired}
          onChange={(e) => set('emailVerifiedRequired', e.target.checked)}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
          Save OIDC settings
        </Button>
        <Button
          type="button"
          loading={testing}
          disabled={!hasConfig || dirty}
          title={dirty ? 'Save your changes first.' : !hasConfig ? 'Save the settings first.' : undefined}
          onClick={onTest}
        >
          Test OIDC sign-in
        </Button>
      </div>
    </form>
  );
}
