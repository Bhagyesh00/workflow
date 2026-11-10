/**
 * P6-18: Settings > Your account, two-step sign-in: set up (QR code, secret, recovery codes with copy and
 * download), disable. Opens the setup dialog when the address has `?mfa=setup` (AppShell sends an enforced
 * user there on `mfa_enrollment_required`); a user who already has MFA on gets the code check instead
 * (`POST /auth/mfa/verify`, which marks the session verified).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Download } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import { mfaApi } from '../../api/endpoints';
import { queryKeys, useMe, useSettings } from '../../api/queries';
import type { MfaSetup } from '../../api/types';
import { Panel } from '../../pages/settings/Panel';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';
import { Badge, Callout, Spinner } from '../ui/misc';
import { QrCode } from './QrCode';

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()}`, 'Select the text and copy it by hand.');
  }
}

/** hands the recovery codes to the browser as a text file (no server round trip) */
function downloadCodes(codes: string[]): void {
  try {
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch {
    toast.error("Couldn't download the codes", 'Copy them instead.');
  }
}

function SetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const started = useRef(false);

  // the secret and recovery codes are shown once: gcTime 0 drops them from the mutation cache on reset
  const start = useMutation({
    mutationFn: () => mfaApi.setup(),
    onSuccess: (result) => setSetup(result),
    gcTime: 0,
  });
  const enable = useMutation({
    mutationFn: (mfaCode: string) => mfaApi.enable(mfaCode),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      ]);
      toast.success('Two-step sign-in is on');
      onClose();
    },
  });

  // a new secret and new codes on each opening (the server makes them per call until the setup is finished)
  useEffect(() => {
    if (!open) {
      started.current = false;
      setSetup(null);
      setCode('');
      setSaved(false);
      start.reset();
      enable.reset();
      return;
    }
    if (started.current) return;
    started.current = true;
    start.mutate();
  }, [open, start.mutate, start.reset, enable.reset]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (/^\d{6}$/.test(code) && saved && !enable.isPending) enable.mutate(code);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Set up two-step sign-in"
      description="Scan the code with an authenticator app, save your recovery codes, then enter the 6 digit code the app shows."
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="mfa-setup-form"
            loading={enable.isPending}
            disabled={!setup || !saved || !/^\d{6}$/.test(code)}
          >
            Turn on
          </Button>
        </>
      }
    >
      {start.isError && (
        <Callout tone="err" title="Could not start the setup">
          {errorMessage(start.error)}
        </Callout>
      )}
      {!setup && !start.isError && (
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> Preparing your code
        </div>
      )}
      {setup && (
        <form id="mfa-setup-form" onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-4">
            <QrCode value={setup.otpauthUrl} label="Authenticator app QR code" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
              <p className="text-ink-2">Or enter this key in your app by hand:</p>
              <code
                className="break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-xs"
                data-testid="mfa-secret"
              >
                {setup.secret}
              </code>
              <Button
                size="sm"
                className="self-start"
                icon={<Copy size={12} />}
                onClick={() => void copyText(setup.secret, 'Key')}
              >
                Copy key
              </Button>
            </div>
          </div>
          <section aria-label="Recovery codes" className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-ink">Recovery codes</p>
            <p className="text-xs text-ink-2">
              Each code works once if you lose your app. They are shown now and never again.
            </p>
            <ul className="grid grid-cols-2 gap-1 rounded-md bg-surface-2 p-2 font-mono text-xs">
              {setup.recoveryCodes.map((recovery) => (
                <li key={recovery}>{recovery}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                size="sm"
                icon={<Copy size={12} />}
                onClick={() => void copyText(setup.recoveryCodes.join('\n'), 'Recovery codes')}
              >
                Copy codes
              </Button>
              <Button
                size="sm"
                icon={<Download size={12} />}
                onClick={() => downloadCodes(setup.recoveryCodes)}
              >
                Download codes
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
              <span>I saved my recovery codes</span>
            </label>
          </section>
          <FormField label="Authentication code" hint="The 6 digit code from your app.">
            {(id) => (
              <TextInput
                id={id}
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            )}
          </FormField>
          {enable.isError && <Callout tone="err">{errorMessage(enable.error)}</Callout>}
        </form>
      )}
    </Dialog>
  );
}

/** an enrolled user whose session did not pass the MFA step (it began before the workspace required it) */
function VerifyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: (mfaCode: string) => mfaApi.verify(mfaCode),
    onSuccess: async () => {
      // every query the gate refused loads again
      await queryClient.invalidateQueries();
      toast.success('Code confirmed');
      onClose();
    },
  });
  useEffect(() => {
    if (open) return;
    setCode('');
    verify.reset();
  }, [open, verify.reset]);
  const ready = /^\d{6}$/.test(code);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !verify.isPending) verify.mutate(code);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Confirm two-step sign-in"
      description="Your workspace requires two-step sign-in. Enter the 6 digit code from your authenticator app to continue."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="mfa-verify-form"
            loading={verify.isPending}
            disabled={!ready}
          >
            Confirm
          </Button>
        </>
      }
    >
      <form id="mfa-verify-form" onSubmit={submit} className="flex flex-col gap-3">
        {verify.isError && <Callout tone="err">{errorMessage(verify.error)}</Callout>}
        <FormField
          label="Authentication code"
          hint="Lost your app? Sign out and sign in with a recovery code."
        >
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
      </form>
    </Dialog>
  );
}

function DisableDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const disable = useMutation({
    mutationFn: () => {
      const text = value.trim();
      return mfaApi.disable(useRecovery ? { mfaRecoveryCode: text } : { mfaCode: text });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      ]);
      toast.success('Two-step sign-in is off');
      onClose();
    },
  });
  useEffect(() => {
    if (open) return;
    setUseRecovery(false);
    setValue('');
    disable.reset();
  }, [open, disable.reset]);
  const ready = useRecovery ? value.trim().length > 0 : /^\d{6}$/.test(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !disable.isPending) disable.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Turn off two-step sign-in"
      description="Enter a code from your authenticator app, or one recovery code, to confirm."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            type="submit"
            form="mfa-disable-form"
            loading={disable.isPending}
            disabled={!ready}
          >
            Turn off
          </Button>
        </>
      }
    >
      <form id="mfa-disable-form" onSubmit={submit} className="flex flex-col gap-3">
        {disable.isError && <Callout tone="err">{errorMessage(disable.error)}</Callout>}
        <FormField label={useRecovery ? 'Recovery code' : 'Authentication code'}>
          {(id) => (
            <TextInput
              id={id}
              value={value}
              autoComplete="off"
              inputMode={useRecovery ? undefined : 'numeric'}
              maxLength={useRecovery ? 64 : 6}
              onChange={(event) =>
                setValue(useRecovery ? event.target.value : event.target.value.replace(/\D/g, ''))
              }
              data-autofocus
            />
          )}
        </FormField>
        <button
          type="button"
          className="self-start text-sm font-semibold text-brand hover:underline"
          onClick={() => {
            setUseRecovery((v) => !v);
            setValue('');
          }}
        >
          {useRecovery ? 'Use an authentication code' : 'Use a recovery code'}
        </button>
      </form>
    </Dialog>
  );
}

export function MfaSection() {
  const me = useMe().data;
  const settings = useSettings();
  const [params, setParams] = useSearchParams();
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const wantsSetup = params.get('mfa') === 'setup';
  const available = settings.features.mfa !== false;
  const enabled = me?.mfaEnabled === true;
  const fenced = me?.ssoFenced === true;

  // `?mfa=setup`: open the setup once the account is known to have none (or the code check when it has MFA
  // on: the session did not pass the step), then drop the parameter
  useEffect(() => {
    if (!wantsSetup || !me) return;
    if (available && !fenced) {
      if (enabled) setVerifyOpen(true);
      else setSetupOpen(true);
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('mfa');
        return next;
      },
      { replace: true },
    );
  }, [wantsSetup, me, enabled, available, fenced, setParams]);

  if (!me) return null;
  return (
    <>
      <Panel
        title="Two-step sign-in"
        description="Ask for a code from an authenticator app when you sign in."
        action={
          !fenced && available ? (
            enabled ? (
              <Button variant="danger" onClick={() => setDisableOpen(true)}>
                Turn off
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setSetupOpen(true)}>
                Set up
              </Button>
            )
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2 px-5 py-4 text-sm">
          {fenced ? (
            <p className="text-ink-2">
              You signed in with single sign-on. Two-step sign-in is managed by your identity provider.
            </p>
          ) : !available ? (
            <p className="text-ink-2">Two-step sign-in is turned off on this server.</p>
          ) : (
            <p className="flex items-center gap-2">
              <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
              <span className="text-ink-2">
                {enabled
                  ? 'Signing in asks for a code from your authenticator app.'
                  : 'Signing in needs only your password.'}
              </span>
            </p>
          )}
          {available && settings.mfa?.enforced && !enabled && !fenced && (
            <Callout tone="warn">Your workspace requires two-step sign-in. Set it up to continue.</Callout>
          )}
        </div>
      </Panel>
      <SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />
      <DisableDialog open={disableOpen} onClose={() => setDisableOpen(false)} />
      <VerifyDialog open={verifyOpen} onClose={() => setVerifyOpen(false)} />
    </>
  );
}
