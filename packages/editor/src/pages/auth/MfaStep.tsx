/**
 * P6-18: the second sign-in step: a 6 digit code from the authenticator app, or a recovery code.
 * LoginPage keeps the email and password and sends them again with the code (POST /auth/login).
 */
import { type FormEvent, useState } from 'react';
import type { MfaLoginInput } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { FormField, TextInput } from '../../components/ui/Field';
import { Callout } from '../../components/ui/misc';

export interface MfaStepProps {
  /** the code is being checked */
  pending: boolean;
  /** the last attempt's error, shown above the field */
  error: string | null;
  onSubmit(input: MfaLoginInput): void;
  /** back to email and password */
  onCancel(): void;
}

export function MfaStep({ pending, error, onSubmit, onCancel }: MfaStepProps) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const ready = useRecovery ? recovery.trim().length > 0 : /^\d{6}$/.test(code);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || pending) return;
    onSubmit(useRecovery ? { mfaRecoveryCode: recovery.trim() } : { mfaCode: code });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && <Callout tone="err">{error}</Callout>}
      {useRecovery ? (
        <FormField label="Recovery code" hint="Each recovery code works once.">
          {(id) => (
            <TextInput
              id={id}
              value={recovery}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setRecovery(event.target.value)}
              data-autofocus
            />
          )}
        </FormField>
      ) : (
        <FormField label="Authentication code" hint="The 6 digit code from your authenticator app.">
          {(id) => (
            <TextInput
              id={id}
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              data-autofocus
            />
          )}
        </FormField>
      )}
      <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
        Sign in
      </Button>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-brand underline-offset-2 hover:underline"
          onClick={() => {
            setUseRecovery((value) => !value);
            setCode('');
            setRecovery('');
          }}
        >
          {useRecovery ? 'Use an authentication code' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-ink-2 hover:text-ink" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}
