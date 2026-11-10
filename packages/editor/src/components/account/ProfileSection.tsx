/**
 * P6-19: Settings > Your account: change name, email (password or MFA code) and password; read only in an
 * SSO session (`Me.ssoFenced`) or for a SCIM managed user (the server refuses with its own text).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { queryKeys, useMe } from '../../api/queries';
import { passwordProblem } from '../../pages/auth/AuthPages';
import { Panel } from '../../pages/settings/Panel';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';

function EmailDialog({ open, mfaEnabled, onClose }: { open: boolean; mfaEnabled: boolean; onClose(): void }) {
  const [email, setEmail] = useState('');
  const [proof, setProof] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () =>
      passwordApi.changeEmail({
        email: email.trim(),
        ...(mfaEnabled ? { mfaCode: proof.trim() } : { currentPassword: proof }),
      }),
    onSuccess: () => setSentTo(email.trim()),
  });
  const close = () => {
    setEmail('');
    setProof('');
    setSentTo(null);
    request.reset();
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !proof || request.isPending) return;
    request.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Change email"
      size="sm"
      footer={
        sentTo ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              loading={request.isPending}
              disabled={!email.trim() || !proof}
              onClick={() => request.mutate()}
            >
              Send confirmation link
            </Button>
          </>
        )
      }
    >
      {sentTo ? (
        <Callout tone="ok">
          We sent a link to {sentTo}. Open it to finish the change. It works once, for 20 minutes.
        </Callout>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {request.error && <Callout tone="err">{errorMessage(request.error)}</Callout>}
          <FormField label="New email">
            {(id) => (
              <TextInput
                id={id}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-autofocus
              />
            )}
          </FormField>
          <FormField
            label={mfaEnabled ? 'Authentication code' : 'Current password'}
            hint={mfaEnabled ? 'The 6 digit code from your authenticator app.' : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                type={mfaEnabled ? 'text' : 'password'}
                autoComplete={mfaEnabled ? 'one-time-code' : 'current-password'}
                value={proof}
                onChange={(e) => setProof(e.target.value)}
              />
            )}
          </FormField>
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function PasswordDialog({
  open,
  mfaEnabled,
  onClose,
}: {
  open: boolean;
  mfaEnabled: boolean;
  onClose(): void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      passwordApi.changePassword({
        currentPassword: current,
        newPassword: next,
        ...(mfaEnabled ? { mfaCode: code.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('Password changed', 'Your other sessions were signed out.');
      close();
    },
  });
  function close() {
    setCurrent('');
    setNext('');
    setAgain('');
    setCode('');
    setTouched(false);
    change.reset();
    onClose();
  }
  const problem = passwordProblem(next);
  const mismatch = again !== '' && again !== next ? 'The passwords do not match' : null;
  const ready = current !== '' && next !== '' && again !== '' && (!mfaEnabled || code.trim() !== '');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!ready || problem || next !== again || change.isPending) return;
    change.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Change password"
      size="sm"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={change.isPending} disabled={!ready} onClick={() => submit()}>
            Change password
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {change.error && <Callout tone="err">{errorMessage(change.error)}</Callout>}
        <FormField label="Current password">
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              data-autofocus
            />
          )}
        </FormField>
        <FormField
          label="New password"
          hint="At least 8 characters, with a letter and a digit."
          error={touched ? problem : null}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Repeat the new password" error={mismatch}>
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          )}
        </FormField>
        {mfaEnabled && (
          <FormField label="Authentication code" hint="The 6 digit code from your authenticator app.">
            {(id) => (
              <TextInput
                id={id}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </FormField>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function ProfileSection() {
  const me = useMe().data;
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const save = useMutation({
    mutationFn: (value: string) => passwordApi.updateProfile({ name: value }),
    onSuccess: async () => {
      setName(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      toast.success('Name saved');
    },
  });
  if (!me) return null;
  const fenced = me.ssoFenced === true;
  const shown = name ?? me.user.name;
  const changed = name !== null && name.trim() !== '' && name.trim() !== me.user.name;
  return (
    <>
      <Panel title="Profile" description="Your name, email address and password.">
        <div className="flex flex-col gap-4 px-5 py-4 text-sm">
          {fenced && (
            <Callout tone="info">
              You signed in with single sign-on. Your name, email and password are managed by your identity
              provider.
            </Callout>
          )}
          {save.error && <Callout tone="err">{errorMessage(save.error)}</Callout>}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (changed && !save.isPending) save.mutate((name ?? '').trim());
            }}
          >
            <FormField label="Name" className="min-w-[240px] flex-1">
              {(id) => (
                <TextInput
                  id={id}
                  value={shown}
                  disabled={fenced}
                  maxLength={128}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </FormField>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={fenced || !changed}>
              Save name
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-ink-3">Email</span>
            <span className="font-semibold">{me.user.email}</span>
            <Button size="sm" disabled={fenced} onClick={() => setEmailOpen(true)}>
              Change email
            </Button>
            <Button size="sm" disabled={fenced} onClick={() => setPasswordOpen(true)}>
              Change password
            </Button>
          </div>
        </div>
      </Panel>
      <EmailDialog open={emailOpen} mfaEnabled={me.mfaEnabled} onClose={() => setEmailOpen(false)} />
      <PasswordDialog open={passwordOpen} mfaEnabled={me.mfaEnabled} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
