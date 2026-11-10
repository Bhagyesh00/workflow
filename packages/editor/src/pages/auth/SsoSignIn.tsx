/**
 * P6-01: the SSO part of the sign-in page (above the password form): asks `authApi.ssoOptions(workspace)`,
 * shows the provider's button, sends the browser to the provider when `redirect` is on (n8n's
 * `SSO_REDIRECT_LOGIN_TO_SSO`) and the workspace came in the link (`?workspace=`), shows `?ssoError=`.
 * The owner fallback: `?password=1` keeps the page on the password form, and the redirect shows that link.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { authApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { SsoOptions } from '../../api/types';
import { Callout } from '../../components/ui/misc';

export interface SsoSignInProps {
  /** the workspace slug (`?workspace=`); absent = none given yet */
  workspace?: string;
  /** the safe same-app path to return to after sign-in */
  redirect?: string;
}

/**
 * The texts of `?ssoError=<code>`: the codes of the server's `SSO_SIGN_IN_ERRORS` (services/sso/login.ts),
 * the OIDC codes of `OIDC_ERROR_CODES` (services/sso/oidc.ts), the SAML codes of `SAML_SIGN_IN_ERRORS`
 * (services/sso/saml.ts) and the start route's refusals. The page never shows the query text itself, so a
 * crafted link cannot put words on it.
 */
export const SSO_ERROR_TEXTS: Readonly<Record<string, string>> = {
  sso_method_inactive: "Single sign-on isn't turned on for this workspace.",
  sso_profile_invalid: "Your identity provider didn't send an email address. Ask an admin of the workspace.",
  sso_email_unverified: "Your identity provider hasn't verified your email address.",
  sso_user_disabled: 'Your access to this workspace is turned off. Ask an admin of the workspace.',
  sso_invite_required: 'This email already has an account. Ask an admin of the workspace for an invite.',
  sso_user_unknown: 'This email has no access to the workspace. Ask an admin of the workspace for an invite.',
  sso_access_blocked: "Your identity provider doesn't give you access to this workspace.",
  sso_state_invalid: 'The sign-in took too long or was started in another browser. Try again.',
  sso_login_failed:
    "Couldn't sign in with your identity provider. Try again, or ask an admin of the workspace.",
  saml_response_invalid:
    "Your identity provider's SAML response couldn't be verified. Try again, or ask an admin of the workspace.",
  saml_response_replayed: 'This SAML response was already used. Sign in again.',
  saml_attributes_missing:
    "Your identity provider didn't send all the user attributes the workspace needs, such as the email. Ask an admin of the workspace.",
  saml_config_invalid: "The workspace's SAML settings can't be read. Ask an admin of the workspace.",
  saml_metadata_invalid: "The workspace's SAML settings can't be read. Ask an admin of the workspace.",
  not_found: 'There is no workspace with this name. Check the workspace name.',
};
export const SSO_ERROR_FALLBACK =
  "Couldn't sign in with single sign-on. Try again, or ask an admin of the workspace.";

/** the text for `?ssoError=`; null without one */
export function ssoErrorText(code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(SSO_ERROR_TEXTS, code) ? SSO_ERROR_TEXTS[code] : SSO_ERROR_FALLBACK;
}

/** SAML or OIDC: the sign-in goes through the identity provider */
export function isSingleSignOn(
  options: SsoOptions | undefined,
): options is SsoOptions & { method: 'saml' | 'oidc' } {
  return options?.method === 'saml' || options?.method === 'oidc';
}

/** where the browser starts a SAML or OIDC sign-in of the workspace (served under `/sso`, outside `/rest`) */
export function ssoStartUrl(method: 'saml' | 'oidc', workspace: string, redirect?: string): string {
  const slug = encodeURIComponent(workspace);
  const path = method === 'saml' ? `/sso/saml/${slug}/initsso` : `/sso/oidc/${slug}/login`;
  return redirect ? `${path}?redirect=${encodeURIComponent(redirect)}` : path;
}

/** the browser's move to the identity provider (a seam: jsdom has no navigation) */
export const ssoNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

/** the workspace's sign-in options; email until a workspace is given */
export function useSsoOptions(workspace?: string) {
  return useQuery({
    queryKey: queryKeys.ssoOptions(workspace ?? ''),
    queryFn: () => authApi.ssoOptions(workspace),
    enabled: Boolean(workspace),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * The page goes straight to the identity provider: SAML or OIDC with `redirect` on, the workspace from the
 * link, no `?ssoError=` (no loop back to a failing provider) and no `?password=1` (the owner fallback).
 */
export function useSsoRedirecting(workspace?: string): boolean {
  const [search] = useSearchParams();
  const { data } = useSsoOptions(workspace);
  return (
    isSingleSignOn(data) &&
    data.redirect &&
    Boolean(workspace) &&
    search.get('workspace') === workspace &&
    !search.has('ssoError') &&
    search.get('password') !== '1'
  );
}

/** the sign-in link that keeps the page on the password form (owners and members an admin allows) */
function passwordHref(search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.delete('ssoError');
  next.set('password', '1');
  return `/signin?${next.toString()}`;
}

export function SsoSignIn({ workspace, redirect }: SsoSignInProps) {
  const [search] = useSearchParams();
  const { data } = useSsoOptions(workspace);
  const redirecting = useSsoRedirecting(workspace);
  const error = ssoErrorText(search.get('ssoError'));
  const start = workspace && isSingleSignOn(data) ? ssoStartUrl(data.method, workspace, redirect) : null;

  useEffect(() => {
    if (redirecting && start) ssoNavigation.go(start);
  }, [redirecting, start]);

  const errorCallout = error ? <Callout tone="err">{error}</Callout> : null;
  if (!start) return errorCallout;
  const label = data?.label ? `Continue with ${data.label}` : 'Continue with SSO';
  if (redirecting) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-ink-2" role="status">
          Taking you to your identity provider…
        </p>
        <Link to={passwordHref(search)} className="text-sm font-semibold text-brand hover:underline">
          Sign in with a password instead
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {errorCallout}
      <a
        href={start}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-brand px-5 text-base font-semibold text-on-brand shadow-card hover:brightness-110"
      >
        {label}
      </a>
      <p className="text-center text-xs text-ink-3">
        Or sign in with a password. That works for owners and for members an admin allows.
      </p>
    </div>
  );
}
