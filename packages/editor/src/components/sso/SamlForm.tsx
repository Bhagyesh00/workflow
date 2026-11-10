/**
 * P6-13: the SAML settings form: the identity provider's metadata (XML or a URL), the attribute mapping, the
 * sign-in binding and the label, "email must be verified", and the two values to give the identity provider.
 * The page owns the requests; the form owns the draft.
 */
import { type FormEvent, useEffect, useState } from 'react';
import type { SamlAttributeMapping, SamlConfig, SamlConfigBody } from '../../api/types';
import { Button } from '../ui/Button';
import { Checkbox, FormField, Select, TextArea, TextInput } from '../ui/Field';
import { CopyField } from './CopyField';

type Draft = Required<Pick<SamlConfig, 'metadata' | 'metadataUrl' | 'loginBinding' | 'loginLabel'>> &
  Pick<SamlConfig, 'emailVerifiedRequired'> & { mapping: SamlAttributeMapping };

function draftOf(config: SamlConfig): Draft {
  return {
    metadata: config.metadata,
    metadataUrl: config.metadataUrl,
    mapping: { ...config.mapping },
    loginBinding: config.loginBinding,
    loginLabel: config.loginLabel,
    emailVerifiedRequired: config.emailVerifiedRequired,
  };
}

const MAPPING_FIELDS: { key: keyof SamlAttributeMapping; label: string }[] = [
  { key: 'email', label: 'Email attribute' },
  { key: 'firstName', label: 'First name attribute' },
  { key: 'lastName', label: 'Last name attribute' },
  { key: 'userPrincipalName', label: 'User principal name attribute' },
];

export interface SamlFormProps {
  config: SamlConfig;
  saving: boolean;
  testing: boolean;
  /** the last save or test error */
  error: string | null;
  onSave(body: SamlConfigBody): void;
  onTest(): void;
  /** the draft differs from what is saved (the page keeps the switch off until it is saved) */
  onDirtyChange?(dirty: boolean): void;
}

export function SamlForm({ config, saving, testing, error, onSave, onTest, onDirtyChange }: SamlFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(config));
  useEffect(() => setDraft(draftOf(config)), [config]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(config));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const hasMetadata = Boolean(config.metadata.trim() || config.metadataUrl.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(draft);
  };

  return (
    <form onSubmit={submit} aria-label="SAML settings" className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {config.entityID && (
          <CopyField label="Entity ID" value={config.entityID} hint="Give this to your identity provider." />
        )}
        {config.returnUrl && (
          <CopyField
            label="Assertion consumer service URL"
            value={config.returnUrl}
            hint="Where the identity provider sends the sign-in response."
          />
        )}
      </div>
      <FormField
        label="Metadata URL"
        hint="Where your identity provider publishes its metadata. Use this or the XML below."
      >
        {(id) => (
          <TextInput
            id={id}
            value={draft.metadataUrl}
            placeholder="https://idp.example.com/metadata"
            onChange={(e) => set('metadataUrl', e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Metadata XML"
        hint="Paste the identity provider's metadata when it has no public URL."
      >
        {(id) => (
          <TextArea
            id={id}
            rows={6}
            className="font-mono text-xs"
            value={draft.metadata}
            onChange={(e) => set('metadata', e.target.value)}
          />
        )}
      </FormField>
      <div className="grid gap-4 md:grid-cols-2">
        {MAPPING_FIELDS.map(({ key, label }) => (
          <FormField key={key} label={label}>
            {(id) => (
              <TextInput
                id={id}
                value={draft.mapping[key]}
                onChange={(e) => set('mapping', { ...draft.mapping, [key]: e.target.value })}
              />
            )}
          </FormField>
        ))}
        <FormField label="Sign-in binding" hint="How the sign-in request travels to the identity provider.">
          {(id) => (
            <Select
              id={id}
              value={draft.loginBinding}
              onChange={(e) => set('loginBinding', e.target.value as Draft['loginBinding'])}
            >
              <option value="redirect">Redirect</option>
              <option value="post">POST</option>
            </Select>
          )}
        </FormField>
        <FormField label="Sign-in button label" hint="Shown on the sign-in page.">
          {(id) => (
            <TextInput
              id={id}
              value={draft.loginLabel}
              placeholder="SAML"
              onChange={(e) => set('loginLabel', e.target.value)}
            />
          )}
        </FormField>
      </div>
      <Checkbox
        label="Refuse sign-ins whose email the identity provider has not verified"
        checked={draft.emailVerifiedRequired}
        onChange={(e) => set('emailVerifiedRequired', e.target.checked)}
      />
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
          Save SAML settings
        </Button>
        <Button
          type="button"
          loading={testing}
          disabled={!hasMetadata || dirty}
          title={dirty ? 'Save your changes first.' : !hasMetadata ? 'Save the metadata first.' : undefined}
          onClick={onTest}
        >
          Test SAML sign-in
        </Button>
      </div>
    </form>
  );
}
