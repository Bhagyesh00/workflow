/**
 * P6-10 (L8): OpenID Connect sign-in per workspace (openid-client with `customFetch = ctx.http.asFetch()`;
 * plain http to the provider only under `ctx.allowInsecureIdp`, a test option). Discovery at save (a failure
 * refuses the save), the secret encrypted (`oidc_secret_enc`, binding tenant and `sso:oidc`), state and
 * nonce in signed cookies (`formTokens`, 15 minutes, no PKCE as n8n), the identity by `sub` with the userinfo
 * merged, the provider's `error_description` never reflected. A sign-in goes through
 * `ctx.ssoLogin.signIn(..., { authMethod: 'oidc' })`; the test flow never issues a session.
 */
import { timingSafeEqual } from 'node:crypto';
import { REDACTED } from '@workflow/core';
import { type DataObject, redactSecrets } from '@workflow/workflow';
import { createRemoteJWKSet, customFetch as joseFetch, type JWTVerifyGetKey, jwtVerify } from 'jose';
import * as client from 'openid-client';
import { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { TenantAuthSettingsRow, TenantRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { createRepositories } from '../../repositories';
import type { AuthResult, SessionMeta } from '../auth';
import { type SsoProfile, SSO_SIGN_IN_ERRORS } from './login';
import { safeSsoRedirect } from './redirect';
import { hasSavedConfig, isSsoMethod } from './settings';

/** what the callback answers the browser: a session, or the test flow's result page */
export type OidcCallbackResult =
  | {
      kind: 'session';
      result: AuthResult;
      redirect: string;
      /** the encrypted id token for the provider's logout (path `/rest`); absent when logout is off or too big */
      idTokenCookie?: string;
    }
  | { kind: 'test'; html: string };

/** a cookie the route sets (httpOnly, path `/sso/oidc/<slug>`, 15 minutes) */
export interface OidcCookie {
  name: string;
  value: string;
}

export const OIDC_STATE_COOKIE = 'wf_oidc_state';
export const OIDC_NONCE_COOKIE = 'wf_oidc_nonce';
/** the encrypted id token, path `/rest` (read by POST /rest/sso/oidc/logout) */
export const OIDC_ID_TOKEN_COOKIE = 'wf_oidc_idt';
export const OIDC_COOKIE_TTL_S = 900;
/** the cookie of the id token is not set above this many bytes: the logout is local only (as n8n) */
export const OIDC_ID_TOKEN_COOKIE_MAX = 3800;

const STATE_KIND = 'sso-oidc-state';
const NONCE_KIND = 'sso-oidc-nonce';
const DISCOVERY_TTL_MS = 3_600_000;
const SECRET_BINDING_ID = 'sso:oidc';
const MAX_ACR = 10;

/** the codes the browser gets as `?ssoError=` besides those of `signIn` (the page shows a fixed text) */
export const OIDC_ERROR_CODES = {
  denied: 'sso_access_blocked',
  failed: 'sso_login_failed',
  state: 'sso_state_invalid',
} as const;

const PROMPTS = ['none', 'login', 'consent', 'select_account', 'create'] as const;
/** asymmetric algorithms only: never `none`, never a shared-secret algorithm */
const SIGNING_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const SCOPE_TOKEN =/^[\x21\x23-\x5b\x5d-\x7e]+$/;

const configInput = z.object({
  clientId: z.string().trim().min(1).max(256).optional(),
  clientSecret: z.string().max(2048).optional(),
  discoveryEndpoint: z.string().trim().min(1).max(2048).optional(),
  loginEnabled: z.boolean().optional(),
  loginLabel: z.string().trim().max(64).optional(),
  prompt: z.enum(PROMPTS).optional(),
  authenticationContextClassReference: z.array(z.string().trim().min(1).max(256)).max(MAX_ACR).optional(),
  additionalScopes: z
    .string()
    .max(512)
    .refine((v) => v.split(/\s+/).filter(Boolean).every((s) => SCOPE_TOKEN.test(s)), 'Invalid scope')
    .optional(),
  emailVerifiedRequired: z.boolean().optional(),
  rpInitiatedLogoutEnabled: z.boolean().optional(),
});

/** the OIDC section of `tenant_auth_settings.oidc` */
interface StoredOidc {
  clientId?: string;
  discoveryEndpoint?: string;
  loginLabel?: string;
  prompt?: (typeof PROMPTS)[number];
  authenticationContextClassReference?: string[];
  additionalScopes?: string;
  emailVerifiedRequired?: boolean;
  rpInitiatedLogoutEnabled?: boolean;
}

/** a signed-in-or-not browser's failure with the code the sign-in page shows */
function failure(code: string, message: string, status = 401): ApiError {
  return new ApiError(status, code, message);
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** the guard's own refusal, if one is anywhere in the error's cause chain */
function guardMessage(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current.name === 'SsrfBlockedError') return current.message;
    current = current.cause;
  }
  return null;
}

/** the reason a discovery failed, for the admin who saves the config (redacted, never the document) */
function discoveryReason(error: unknown): string {
  const guard = guardMessage(error);
  if (guard) return redactSecrets(guard);
  if (error instanceof Error && error.message) return redactSecrets(error.message.slice(0, 200));
  return 'the request failed';
}

function emailVerifiedClaim(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** JSON claims only: drops anything a JSON body cannot hold */
function claimsOf(source: Record<string, unknown>): DataObject {
  return JSON.parse(JSON.stringify(source)) as DataObject;
}

export class OidcService {
  /** discovered providers by tenant, endpoint, client and secret, one hour */
  private readonly discovered = new Map<string, { config: client.Configuration; expires: number }>();
  /** the provider's signing keys, read through the guarded fetch, one set per discovered configuration */
  private readonly keySets = new WeakMap<client.Configuration, JWTVerifyGetKey>();

  constructor(readonly deps: ServiceDeps) {}

  private get ctx() {
    return this.deps.context();
  }

  private callbackUrl(slug: string): string {
    return `${this.deps.config.baseUrl}/sso/oidc/${encodeURIComponent(slug)}/callback`;
  }

  private stored(row: TenantAuthSettingsRow | undefined): StoredOidc {
    return (row?.oidc ?? {}) as StoredOidc;
  }

  private decryptSecret(tenantId: string, row: TenantAuthSettingsRow | undefined): string | null {
    if (!row?.oidcSecretEnc) return null;
    try {
      return this.ctx.cipher.decrypt<string>(row.oidcSecretEnc, {
        tenantId,
        credentialId: SECRET_BINDING_ID,
      });
    } catch {
      return null;
    }
  }

  private dropDiscovered(tenantId: string): void {
    for (const key of this.discovered.keys()) if (key.startsWith(`${tenantId}\n`)) this.discovered.delete(key);
  }

  /** discovery through the guarded fetch; the result is the client's configuration */
  private async discover(
    endpoint: string,
    clientId: string,
    secret: string,
  ): Promise<client.Configuration> {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw ApiError.badRequest('The discovery endpoint must be a URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw ApiError.badRequest('The discovery endpoint must be an https URL');
    }
    const ctx = this.ctx;
    return client.discovery(url, clientId, { client_secret: secret }, client.ClientSecretPost(secret), {
      [client.customFetch]: ctx.http.asFetch(),
      // plain http to the provider only in a test server (`ContextOptions.allowInsecureIdp`)
      execute: ctx.allowInsecureIdp ? [client.allowInsecureRequests] : [],
    });
  }

  /** the workspace's provider configuration, from the cache or by discovery */
  private async configuration(
    tenantId: string,
    row: TenantAuthSettingsRow | undefined,
  ): Promise<client.Configuration> {
    const oidc = this.stored(row);
    const secret = this.decryptSecret(tenantId, row);
    if (!row || !oidc.clientId || !oidc.discoveryEndpoint || !secret) {
      throw failure('sso_method_inactive', SSO_SIGN_IN_ERRORS.sso_method_inactive, 403);
    }
    const key = [tenantId, oidc.discoveryEndpoint, oidc.clientId, row.oidcSecretEnc?.slice(-24)].join('\n');
    const hit = this.discovered.get(key);
    if (hit && hit.expires > Date.now()) return hit.config;
    const config = await this.discover(oidc.discoveryEndpoint, oidc.clientId, secret);
    this.discovered.set(key, { config, expires: Date.now() + DISCOVERY_TTL_MS });
    return config;
  }

  /**
   * The id token's signature, checked against the provider's JWKS (read through the guarded fetch). The
   * library trusts a token that came straight from the token endpoint over TLS; this check does not rely on
   * that, and it makes the `jwks_uri` a guarded request on every sign-in.
   */
  private async verifySignature(config: client.Configuration, idToken: string): Promise<void> {
    const metadata = config.serverMetadata();
    const jwksUri = metadata.jwks_uri;
    if (!jwksUri || !metadata.issuer) throw new Error('The provider publishes no signing keys');
    let keys = this.keySets.get(config);
    if (!keys) {
      const url = new URL(jwksUri);
      if (url.protocol !== 'https:' && !(this.ctx.allowInsecureIdp && url.protocol === 'http:')) {
        throw new Error('The provider keys must be read over https');
      }
      keys = createRemoteJWKSet(url, { [joseFetch]: this.ctx.http.asFetch() });
      this.keySets.set(config, keys);
    }
    const offered = metadata.id_token_signing_alg_values_supported ?? ['RS256'];
    const algorithms = offered.filter((alg) => SIGNING_ALGORITHMS.includes(alg));
    await jwtVerify(idToken, keys, {
      issuer: metadata.issuer,
      audience: config.clientMetadata().client_id,
      algorithms: algorithms.length ? algorithms : ['RS256'],
    });
  }

  private scopes(row: TenantAuthSettingsRow, oidc: StoredOidc): string {
    const scopes = ['openid', 'email', 'profile'];
    const provisioning = (row.provisioning ?? {}) as Record<string, unknown>;
    const managed =
      provisioning.scopesProvisionInstanceRole === true || provisioning.scopesProvisionProjectRoles === true;
    const named = stringClaim(provisioning.scopesName);
    if (managed && named) scopes.push(named);
    for (const scope of (oidc.additionalScopes ?? '').split(/\s+/)) if (scope) scopes.push(scope);
    return [...new Set(scopes)].join(' ');
  }

  /** the authorization URL and the state and nonce cookies of one browser */
  private async authorization(
    tenant: TenantRow,
    row: TenantAuthSettingsRow,
    options: { returnTo?: string; test: boolean },
  ): Promise<{ url: string; cookies: OidcCookie[] }> {
    const config = await this.configuration(tenant.id, row);
    const oidc = this.stored(row);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const params: Record<string, string> = {
      redirect_uri: this.callbackUrl(tenant.slug),
      response_type: 'code',
      scope: this.scopes(row, oidc),
      state,
      nonce,
      prompt: oidc.prompt ?? 'select_account',
    };
    const acr = (oidc.authenticationContextClassReference ?? []).filter(Boolean);
    if (acr.length) params.acr_values = acr.join(' ');
    const { formTokens } = this.ctx;
    return {
      url: client.buildAuthorizationUrl(config, params).href,
      cookies: [
        {
          name: OIDC_STATE_COOKIE,
          value: formTokens.sign(
            {
              kind: STATE_KIND,
              tenantId: tenant.id,
              state,
              test: options.test,
              returnTo: options.returnTo ?? '/',
            },
            OIDC_COOKIE_TTL_S,
          ),
        },
        {
          name: OIDC_NONCE_COOKIE,
          value: formTokens.sign({ kind: NONCE_KIND, tenantId: tenant.id, nonce }, OIDC_COOKIE_TTL_S),
        },
      ],
    };
  }

  private async tenantBySlug(slug: string): Promise<TenantRow> {
    const tenant = await this.deps.repos.tenants.getBySlug(slug);
    if (!tenant) throw ApiError.notFound('Workspace');
    return tenant;
  }

  /** GET /sso/oidc/:slug/login: the provider's authorization URL and the state and nonce cookies to set */
  async loginUrl(slug: string, returnTo?: string): Promise<{ url: string; cookies: OidcCookie[] }> {
    const tenant = await this.tenantBySlug(slug);
    const row = await this.deps.repos.sso.get(tenant.id);
    // GHSA-pf83-w3f9-8m37: a workspace whose active method is not OIDC starts no sign-in
    if (!row || row.method !== 'oidc') {
      throw failure('sso_method_inactive', SSO_SIGN_IN_ERRORS.sso_method_inactive, 403);
    }
    try {
      return await this.authorization(tenant, row, {
        returnTo: safeSsoRedirect(returnTo, this.deps.config.baseUrl),
        test: false,
      });
    } catch (error) {
      throw this.asFailure(tenant.id, error);
    }
  }

  /** a library or network error becomes the one code the page shows; no text of it goes on */
  private asFailure(tenantId: string, error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    this.deps.logger.warn(
      { tenantId, kind: error instanceof Error ? error.name : 'unknown' },
      'OIDC request failed',
    );
    return failure(OIDC_ERROR_CODES.failed, 'Single sign-on failed');
  }

  /** the verified state and nonce of this browser, or the refusal */
  private cookieChecks(
    tenant: TenantRow,
    cookies: Record<string, string | undefined>,
  ): { state: string; nonce: string; returnTo: string; test: boolean } {
    const { formTokens } = this.ctx;
    const statePayload = cookies[OIDC_STATE_COOKIE] ? formTokens.verify(cookies[OIDC_STATE_COOKIE]!) : null;
    const noncePayload = cookies[OIDC_NONCE_COOKIE] ? formTokens.verify(cookies[OIDC_NONCE_COOKIE]!) : null;
    if (
      !statePayload ||
      !noncePayload ||
      statePayload.kind !== STATE_KIND ||
      noncePayload.kind !== NONCE_KIND ||
      statePayload.tenantId !== tenant.id ||
      noncePayload.tenantId !== tenant.id ||
      typeof statePayload.state !== 'string' ||
      typeof noncePayload.nonce !== 'string'
    ) {
      throw failure(OIDC_ERROR_CODES.state, 'The sign-in link expired. Start the sign-in again.');
    }
    return {
      state: statePayload.state,
      nonce: noncePayload.nonce,
      returnTo: typeof statePayload.returnTo === 'string' ? statePayload.returnTo : '/',
      test: statePayload.test === true,
    };
  }

  /** GET /sso/oidc/:slug/callback */
  async callback(
    slug: string,
    query: DataObject,
    cookies: Record<string, string | undefined>,
    meta: SessionMeta,
  ): Promise<OidcCallbackResult> {
    const tenant = await this.tenantBySlug(slug);
    let test = false;
    try {
      const checks = this.cookieChecks(tenant, cookies);
      test = checks.test;
      const given = stringClaim(query.state);
      if (!given || !sameString(given, checks.state)) {
        throw failure(OIDC_ERROR_CODES.state, 'The sign-in link expired. Start the sign-in again.');
      }
      const row = await this.deps.repos.sso.get(tenant.id);
      // GHSA-pf83-w3f9-8m37: only the test flow runs while OIDC is not the active method
      if (!row || (!test && row.method !== 'oidc')) {
        throw failure('sso_method_inactive', SSO_SIGN_IN_ERRORS.sso_method_inactive, 403);
      }
      // the provider's own error text (`error_description`) is never read, let alone reflected
      if (stringClaim(query.error)) {
        throw failure(
          query.error === 'access_denied' ? OIDC_ERROR_CODES.denied : OIDC_ERROR_CODES.failed,
          'The identity provider did not sign you in',
        );
      }
      const config = await this.configuration(tenant.id, row);
      const current = new URL(this.callbackUrl(tenant.slug));
      for (const name of ['code', 'state', 'iss'] as const) {
        const value = stringClaim(query[name]);
        if (value && value.length <= 4096) current.searchParams.set(name, value);
      }
      const tokens = await client.authorizationCodeGrant(config, current, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      if (!tokens.id_token) throw failure(OIDC_ERROR_CODES.failed, 'The identity provider sent no id token');
      await this.verifySignature(config, tokens.id_token);
      const idClaims = tokens.claims();
      if (!idClaims || typeof idClaims.sub !== 'string' || !idClaims.sub) {
        throw failure(OIDC_ERROR_CODES.failed, 'The identity provider sent no id token');
      }
      let merged: Record<string, unknown> = { ...idClaims };
      if (config.serverMetadata().userinfo_endpoint) {
        const info = await client.fetchUserInfo(config, tokens.access_token, idClaims.sub);
        // the signed id token wins where both say something
        merged = { ...info, ...idClaims };
      }
      const profile = this.profileOf(merged, idClaims.sub);
      if (checks.test) return { kind: 'test', html: this.testPage(true, profile.email) };

      const result = await this.ctx.ssoLogin.signIn(tenant, profile, meta, { authMethod: 'oidc' });
      return {
        kind: 'session',
        result,
        redirect: safeSsoRedirect(checks.returnTo, this.deps.config.baseUrl),
        idTokenCookie: this.idTokenCookie(tenant.id, result.user.id, row, config, tokens.id_token),
      };
    } catch (error) {
      if (test) return { kind: 'test', html: this.testPage(false) };
      const refusal = this.asFailure(tenant.id, error);
      if (!(refusal.code in SSO_SIGN_IN_ERRORS)) {
        // `signIn` writes its own line; a failure before it is audited here, by reason code only
        await this.deps.repos.audit
          .add(tenant.id, {
            action: 'auth.sso_login_failed',
            metadata: { method: 'oidc', reason: refusal.code },
            ip: meta.ip,
          })
          .catch(() => {});
      }
      throw refusal;
    }
  }

  private profileOf(claims: Record<string, unknown>, sub: string): SsoProfile {
    const email = stringClaim(claims.email) ?? '';
    const given = stringClaim(claims.given_name);
    const family = stringClaim(claims.family_name);
    let firstName = given;
    let lastName = family;
    if (!firstName && !lastName) {
      const [first, ...rest] = (stringClaim(claims.name) ?? '').split(/\s+/).filter(Boolean);
      firstName = first;
      lastName = rest.join(' ') || undefined;
    }
    return {
      providerType: 'oidc',
      providerId: sub,
      email,
      firstName,
      lastName,
      emailVerified: emailVerifiedClaim(claims.email_verified),
      claims: claimsOf(claims),
    };
  }

  private idTokenCookie(
    tenantId: string,
    userId: string,
    row: TenantAuthSettingsRow,
    config: client.Configuration,
    idToken: string | undefined,
  ): string | undefined {
    if (!idToken || this.stored(row).rpInitiatedLogoutEnabled !== true) return undefined;
    if (!config.serverMetadata().end_session_endpoint) return undefined;
    const value = this.ctx.cipher.encrypt(idToken, { tenantId, credentialId: `sso:oidc:idt:${userId}` });
    return Buffer.byteLength(value) > OIDC_ID_TOKEN_COOKIE_MAX ? undefined : value;
  }

  /** the page of the test flow; it holds fixed words and the signed-in email only, escaped */
  private testPage(ok: boolean, email?: string): string {
    const title = ok ? 'Test sign-in worked' : "Test sign-in didn't work";
    const body = ok
      ? `The identity provider signed in ${escapeHtml(email || 'a user')}. No session was started.`
      : "The identity provider's answer was refused. Check the client, the secret and the discovery endpoint, then try again.";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;color:#1f2933}h1{font-size:1.25rem}</style></head><body><h1>${title}</h1><p>${body}</p><p>You can close this window.</p></body></html>`;
  }

  /** GET /rest/sso/oidc/config (`oidc:manage`): the config with the secret blank */
  async getConfig(tenantId: string): Promise<DataObject> {
    const tenant = (await this.deps.repos.tenants.get(tenantId))!;
    const row = await this.deps.repos.sso.get(tenantId);
    const oidc = this.stored(row);
    return {
      clientId: oidc.clientId ?? '',
      clientSecret: '',
      discoveryEndpoint: oidc.discoveryEndpoint ?? '',
      loginEnabled: row?.method === 'oidc',
      ...(oidc.loginLabel ? { loginLabel: oidc.loginLabel } : {}),
      prompt: oidc.prompt ?? 'select_account',
      authenticationContextClassReference: oidc.authenticationContextClassReference ?? [],
      additionalScopes: oidc.additionalScopes ?? '',
      emailVerifiedRequired: oidc.emailVerifiedRequired === true,
      rpInitiatedLogoutEnabled: oidc.rpInitiatedLogoutEnabled === true,
      callbackUrl: this.callbackUrl(tenant.slug),
    };
  }

  /** POST /rest/sso/oidc/config (`oidc:manage`); discovery first; also the public PUT (L12) */
  async saveConfig(tenantId: string, input: DataObject, actorId: string | null): Promise<DataObject> {
    const parsed = configInput.safeParse(input);
    if (!parsed.success) {
      throw ApiError.badRequest(
        `Invalid OIDC settings: ${parsed.error.issues.map((i) => i.path.join('.') || 'body').join(', ')}`,
      );
    }
    const body = parsed.data;
    const row = await this.deps.repos.sso.get(tenantId);
    const before = this.stored(row);
    const clientId = body.clientId ?? before.clientId;
    const discoveryEndpoint = body.discoveryEndpoint ?? before.discoveryEndpoint;
    if (!clientId) throw ApiError.badRequest('The client ID is required');
    if (!discoveryEndpoint) throw ApiError.badRequest('The discovery endpoint is required');
    // a blank (or the redaction sentinel) keeps the stored secret
    const given = body.clientSecret && body.clientSecret !== REDACTED ? body.clientSecret : undefined;
    const secret = given ?? this.decryptSecret(tenantId, row);
    if (!secret) throw ApiError.badRequest('The client secret is required');

    let config: client.Configuration;
    try {
      config = await this.discover(discoveryEndpoint, clientId, secret);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        'oidc_discovery_failed',
        `Couldn't read the provider's discovery document: ${discoveryReason(error)}`,
      );
    }

    const next: StoredOidc = {
      ...before,
      clientId,
      discoveryEndpoint,
      prompt: body.prompt ?? before.prompt ?? 'select_account',
      authenticationContextClassReference:
        body.authenticationContextClassReference ?? before.authenticationContextClassReference ?? [],
      additionalScopes: body.additionalScopes ?? before.additionalScopes ?? '',
      emailVerifiedRequired: body.emailVerifiedRequired ?? before.emailVerifiedRequired ?? false,
      rpInitiatedLogoutEnabled: body.rpInitiatedLogoutEnabled ?? before.rpInitiatedLogoutEnabled ?? false,
    };
    if (body.loginLabel !== undefined) next.loginLabel = body.loginLabel || undefined;
    const secretEnc = given
      ? this.ctx.cipher.encrypt(given, { tenantId, credentialId: SECRET_BINDING_ID })
      : row?.oidcSecretEnc;

    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.sso.upsert(tenantId, { oidc: next as Record<string, unknown>, oidcSecretEnc: secretEnc });
      if (body.loginEnabled !== undefined) {
        await this.setLogin(repos, tenantId, body.loginEnabled, actorId);
      }
      await repos.audit.add(tenantId, {
        userId: actorId,
        action: 'sso.oidc_config_updated',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { secretChanged: Boolean(given), loginEnabled: body.loginEnabled ?? null },
      });
    });
    this.dropDiscovered(tenantId);
    const saved = await this.deps.repos.sso.get(tenantId);
    this.discovered.set(
      [tenantId, discoveryEndpoint, clientId, saved?.oidcSecretEnc?.slice(-24)].join('\n'),
      { config, expires: Date.now() + DISCOVERY_TTL_MS },
    );
    return this.getConfig(tenantId);
  }

  /** the toggle: the same rules as `SsoSettingsService.setMethod` (one method; through email) */
  private async setLogin(
    repos: ReturnType<typeof createRepositories>,
    tenantId: string,
    enabled: boolean,
    actorId: string | null,
  ): Promise<void> {
    const row = await repos.sso.get(tenantId);
    const current = row?.method ?? 'email';
    const target = enabled ? 'oidc' : 'email';
    if (enabled && current === 'oidc') return;
    if (!enabled && current !== 'oidc') return;
    if (enabled && current !== 'email') {
      throw new ApiError(
        400,
        'sso_switch_through_email',
        'Turn the current sign-in method off first. A workspace moves from one sign-in method to another through email sign-in.',
      );
    }
    if (enabled && !hasSavedConfig(row, 'oidc')) {
      throw new ApiError(400, 'sso_config_missing', 'Save the OIDC settings before turning OIDC on.');
    }
    await repos.sso.upsert(tenantId, { method: target });
    if (isSsoMethod(current)) await repos.sso.disableScim(tenantId);
    await repos.audit.add(tenantId, {
      userId: actorId,
      action: 'sso.method_changed',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { from: current, to: target },
    });
  }

  /** POST /rest/sso/oidc/config/test: the authorization URL of a test sign-in (and its cookies) */
  async testUrl(tenantId: string): Promise<{ url: string; cookies: OidcCookie[] }> {
    const tenant = (await this.deps.repos.tenants.get(tenantId))!;
    const row = await this.deps.repos.sso.get(tenantId);
    if (!row || !hasSavedConfig(row, 'oidc') || !row.oidcSecretEnc) {
      throw ApiError.badRequest('Save the OIDC settings before testing them');
    }
    try {
      return await this.authorization(tenant, row, { test: true });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        'oidc_discovery_failed',
        `Couldn't read the provider's discovery document: ${discoveryReason(error)}`,
      );
    }
  }

  /** POST /rest/sso/oidc/logout: ends the session first, then the provider's end session URL (if any) */
  async logout(
    auth: AuthContext,
    options: { idTokenCookie?: string; ip?: string } = {},
  ): Promise<{ redirect: string | null }> {
    if (auth.sessionId) {
      await this.ctx.auth.logout(auth.sessionId, auth.tenant.id, auth.user.id, options.ip);
    }
    if (!options.idTokenCookie) return { redirect: null };
    try {
      const row = await this.deps.repos.sso.get(auth.tenant.id);
      if (!row || row.method !== 'oidc' || this.stored(row).rpInitiatedLogoutEnabled !== true) {
        return { redirect: null };
      }
      const idToken = this.ctx.cipher.decrypt<string>(options.idTokenCookie, {
        tenantId: auth.tenant.id,
        credentialId: `sso:oidc:idt:${auth.user.id}`,
      });
      const config = await this.configuration(auth.tenant.id, row);
      if (!config.serverMetadata().end_session_endpoint) return { redirect: null };
      const url = client.buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: `${this.deps.config.baseUrl}/signin`,
      });
      return { redirect: url.href };
    } catch {
      // the provider is unreachable or the cookie is not ours: the local logout stands
      return { redirect: null };
    }
  }
}
