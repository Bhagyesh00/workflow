/**
 * P6-87: `/credential-connect/:id?action=connect|disconnect&returnTo=`: a signed-in user connects or
 * disconnects their own account on a private credential (`privateCredentialsApi`), then goes back to the form,
 * chat or webhook they came from. A public form, chat or webhook only links here (a top-level navigation): the
 * session is this page's own, and no session, token or secret travels in the link. `returnTo` must stay on a
 * form, chat or webhook path of this server (the `staysOnForm` rule of FormSignInPage), so the page cannot
 * be used to redirect elsewhere.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { credentialsApi, privateCredentialsApi } from '../../api/endpoints';
import { useMe } from '../../api/queries';
import { interpretOAuthMessage, OAUTH2_CHANNEL } from '../../components/credentials/CredentialModal';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoader } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';
import { formReturn, isFormReturnPath, isWebhookReturnPath } from './FormSignInPage';

/** how long a provider sign-in may take before the page stops listening for its result */
const WAIT_MS = 10 * 60_000;

type Action = 'connect' | 'disconnect';
type Phase = 'idle' | 'working' | 'waiting' | 'done' | 'failed';

/** a form, chat or webhook path on this server: the only places this page returns to */
export function isConnectReturnPath(value: string | null): value is string {
  return isFormReturnPath(value) || isWebhookReturnPath(value);
}

function actionOf(value: string | null): Action | null {
  return value === 'connect' || value === 'disconnect' ? value : null;
}

export function CredentialConnectPage() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const action = actionOf(search.get('action') ?? 'connect');
  const returnTo = search.get('returnTo');
  const valid = action !== null && /^[\w-]{1,64}$/.test(id) && isConnectReturnPath(returnTo);

  const me = useMe();
  const credential = useQuery({
    queryKey: ['credential-connect', id],
    queryFn: () => credentialsApi.get(id),
    enabled: valid && me.isSuccess,
    retry: false,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  if (!valid) {
    return (
      <AuthLayout title="Couldn't open this page">
        <Callout tone="err">This link isn't valid.</Callout>
      </AuthLayout>
    );
  }
  if (isApiError(me.error, 401)) {
    const back = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/signin?redirect=${back}`} replace />;
  }
  if (me.isPending) return <PageLoader label="Checking your sign-in" />;

  const name = credential.data?.name;
  const fail = (error: unknown) => {
    // the session ended while the page was open: reload, which sends it to sign-in
    if (isApiError(error, 401)) return void window.location.reload();
    setMessage(errorMessage(error));
    setPhase('failed');
  };

  const disconnect = async () => {
    setPhase('working');
    try {
      await privateCredentialsApi.disconnect(id);
      setPhase('done');
    } catch (error) {
      fail(error);
    }
  };

  const connect = async () => {
    cleanup.current?.();
    setPhase('working');
    try {
      const { url } = await privateCredentialsApi.connect(id);
      const target = new URL(url, window.location.origin);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        throw new Error('Unsupported authorization URL');
      }
      const popup = window.open(target.href, 'wf-oauth2', 'width=620,height=760');
      if (!popup) throw new Error('The browser blocked the sign-in window. Allow pop-ups and try again.');
      setPhase('waiting');
      const stop = () => {
        window.removeEventListener('message', onMessage);
        window.clearInterval(timer);
        window.clearTimeout(expiry);
        channel?.close();
        cleanup.current = null;
      };
      const finish = (result: { ok: boolean; message?: string }) => {
        stop();
        if (result.ok) {
          setPhase('done');
        } else {
          setMessage(result.message ?? 'The provider did not connect the account');
          setPhase('failed');
        }
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== popup) return;
        const result = interpretOAuthMessage(event.data);
        if (result) finish(result);
      };
      // the callback page also announces the result to every tab of its origin
      const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OAUTH2_CHANNEL);
      if (channel) {
        channel.onmessage = (event: MessageEvent) => {
          if ((event.data as { credentialId?: unknown } | null)?.credentialId !== id) return;
          const result = interpretOAuthMessage(event.data);
          if (result) finish(result);
        };
      }
      // closing the window is how a user cancels: back to idle, no error
      const timer = window.setInterval(() => {
        if (popup.closed) setPhase((p) => (p === 'waiting' ? 'idle' : p));
      }, 500);
      const expiry = window.setTimeout(stop, WAIT_MS);
      cleanup.current = stop;
      window.addEventListener('message', onMessage);
    } catch (error) {
      fail(error);
    }
  };

  const connecting = action === 'connect';
  const subject = name ? `"${name}"` : 'your account';
  const busy = phase === 'working' || phase === 'waiting';
  if (phase === 'done') {
    return (
      <AuthLayout
        title={connecting ? 'Account connected' : 'Account disconnected'}
        subtitle={connecting ? `${subject} is connected to your user.` : `${subject} is no longer connected.`}
      >
        <Button variant="primary" size="lg" onClick={() => formReturn.go(returnTo)}>
          Back to where you were
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={connecting ? 'Connect your account' : 'Disconnect your account'}
      subtitle={
        connecting
          ? `Sign in to the provider so runs you start can use ${subject}.`
          : `Runs you start will no longer be able to use ${subject}.`
      }
    >
      <div className="flex flex-col gap-4">
        {phase === 'failed' && <Callout tone="err">{message}</Callout>}
        {phase === 'waiting' && <Callout tone="info">Finish signing in in the window that opened.</Callout>}
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          onClick={() => void (connecting ? connect() : disconnect())}
        >
          {connecting ? 'Connect' : 'Disconnect'}
        </Button>
        <Button variant="ghost" size="lg" onClick={() => formReturn.go(returnTo)}>
          Back without changes
        </Button>
      </div>
    </AuthLayout>
  );
}
