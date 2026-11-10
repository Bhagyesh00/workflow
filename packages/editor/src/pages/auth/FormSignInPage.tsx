/**
 * Top-level `/form-auth`: signs a user in for a protected form, chat or webhook (P6-87: a Webhook with
 * "Workspace sign-in (OAuth2)" opened in a browser). A form, chat or webhook never sees the session, so it
 * sends every visitor without a token here. With a session this page asks for the one-time code and goes
 * back to it; without one it goes to sign-in and comes back. The server takes a webhook path only for a
 * Webhook node with that sign-in.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client';
import { formAuthApi } from '../../api/endpoints';
import { Callout, PageLoader } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

/** a Chat Trigger's address on this server: production or test, ending in /chat */
export function isChatPath(value: string): boolean {
  return /^\/webhook(-test)?\/[^/]+\/.+\/chat$/.test(value.split('?')[0]);
}

/** printable ASCII only, no backslash, and no way out of the path, plain or encoded */
function staysOnForm(value: string): boolean {
  if (/[^\x21-\x7e]|\\/.test(value)) return false;
  return !value
    .split('?')[0]
    .split('/')
    .some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

/** a form or chat path on this server, as the server checks it */
export function isFormReturnPath(value: string | null): value is string {
  if (!value || !(/^\/form(-test|-waiting)?\/./.test(value) || isChatPath(value))) return false;
  return staysOnForm(value);
}

/** a webhook path on this server: production or test, the workspace, then a path (the server checks the node) */
export function isWebhookReturnPath(value: string | null): value is string {
  if (!value || !/^\/webhook(-test)?\/[^/?]+\/[^?]/.test(value)) return false;
  return staysOnForm(value);
}

/** leaves the app; `replace`, so that Back does not come here for another code */
export const formReturn = {
  go(url: string) {
    window.location.replace(url);
  },
};

function withCode(returnTo: string, code: string): string {
  const url = new URL(returnTo, window.location.origin);
  url.searchParams.set('code', code);
  return `${url.pathname}${url.search}`;
}

type Failure = { signedOut: true } | { signedOut: false; message: string };

function CouldNotOpen({
  message,
  signInUrl,
  what = 'form',
}: {
  message: string;
  signInUrl?: string;
  what?: 'form' | 'chat' | 'webhook';
}) {
  return (
    <AuthLayout
      title={`Couldn't open this ${what}`}
      footer={
        signInUrl ? (
          <Link to={signInUrl} className="font-semibold text-brand hover:underline">
            Sign in with another account
          </Link>
        ) : undefined
      }
    >
      <Callout tone="err">{message}</Callout>
    </AuthLayout>
  );
}

export function FormSignInPage() {
  const [search] = useSearchParams();
  const returnTo = search.get('redirect');
  const valid = isFormReturnPath(returnTo) || isWebhookReturnPath(returnTo);
  const [failure, setFailure] = useState<Failure | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (!valid || asked.current) return;
    asked.current = true;
    formAuthApi
      .issueCode(returnTo)
      .then(({ code }) => formReturn.go(withCode(returnTo, code)))
      .catch((error: unknown) =>
        setFailure(
          isApiError(error, 401) ? { signedOut: true } : { signedOut: false, message: errorMessage(error) },
        ),
      );
  }, [valid, returnTo]);

  if (!valid) return <CouldNotOpen message="This sign-in link isn't valid." />;
  const what = isChatPath(returnTo) ? 'chat' : isWebhookReturnPath(returnTo) ? 'webhook' : 'form';
  const signInUrl = `/signin?redirect=${encodeURIComponent(`/form-auth?redirect=${encodeURIComponent(returnTo)}`)}`;
  if (failure?.signedOut) return <Navigate to={signInUrl} replace />;
  if (failure) return <CouldNotOpen message={failure.message} signInUrl={signInUrl} what={what} />;
  return <PageLoader label={`Opening the ${what}`} />;
}
