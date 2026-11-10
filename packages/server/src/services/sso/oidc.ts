/**
 * P6-10 (L8): OpenID Connect sign-in per workspace (openid-client with `customFetch = ctx.http.asFetch()`;
 * plain http to the provider only under `ctx.allowInsecureIdp`, a test option). Discovery at save, the
 * secret encrypted (`oidc_secret_enc`), state and nonce in signed cookies, the identity by `sub`, the
 * provider's `error_description` never reflected. A sign-in goes through
 * `ctx.ssoLogin.signIn(..., { authMethod: 'oidc' })`.
 * Stub from C0: every method throws until L8.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import type { AuthResult, SessionMeta } from '../auth';

/** what the callback answers the browser: a session, or the test flow's result page */
export type OidcCallbackResult =
  | { kind: 'session'; result: AuthResult; redirect: string }
  | { kind: 'test'; html: string };

export class OidcService {
  constructor(readonly deps: ServiceDeps) {}

  /** GET /sso/oidc/:slug/login: the provider's authorization URL and the state and nonce cookies to set */
  async loginUrl(
    _slug: string,
    _returnTo?: string,
  ): Promise<{ url: string; cookies: Array<{ name: string; value: string }> }> {
    throw new Error('not implemented (L8)');
  }

  /** GET /sso/oidc/:slug/callback */
  async callback(
    _slug: string,
    _query: DataObject,
    _cookies: Record<string, string | undefined>,
    _meta: SessionMeta,
  ): Promise<OidcCallbackResult> {
    throw new Error('not implemented (L8)');
  }

  /** GET /rest/sso/oidc/config (`oidc:manage`): the config with the secret as a sentinel */
  async getConfig(_tenantId: string): Promise<DataObject> {
    throw new Error('not implemented (L8)');
  }

  /** POST /rest/sso/oidc/config (`oidc:manage`); discovery first; also the public PUT (L12) */
  async saveConfig(_tenantId: string, _input: DataObject, _actorId: string | null): Promise<DataObject> {
    throw new Error('not implemented (L8)');
  }

  /** POST /rest/sso/oidc/config/test: the authorization URL of a test sign-in */
  async testUrl(_tenantId: string): Promise<{ url: string }> {
    throw new Error('not implemented (L8)');
  }

  /** POST /rest/sso/oidc/logout: ends the session first, then the provider's end session URL (if any) */
  async logout(_auth: AuthContext): Promise<{ redirect: string | null }> {
    throw new Error('not implemented (L8)');
  }
}
