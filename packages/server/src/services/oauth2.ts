/**
 * OAuth2 authorization-code flow (ARCHITECTURE.md §9). The `state` parameter is an HMAC-signed,
 * tenant-bound token with a 10 minute TTL; the PKCE verifier travels inside it encrypted with
 * the credential cipher, so nothing has to be stored server-side between the two requests and
 * nothing secret is visible in the browser.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialCipher, HttpClient } from '@workflow/core';
import { assertCredentialUrlAllowed, type DataObject, getCredentialAllowedDomains } from '@workflow/workflow';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import { hasRole } from './auth';
import type { CredentialService } from './credentials';

const STATE_TTL_MS = 10 * 60_000;

interface StatePayload {
  t: string; // tenant id
  c: string; // credential id
  u: string; // user id
  e: number; // expiry (epoch ms)
  n: string; // nonce
  v?: string; // encrypted PKCE verifier
}

export class OAuth2Service {
  private readonly stateKey: Buffer;

  constructor(
    private readonly config: Config,
    private readonly repos: Repositories,
    private readonly credentials: CredentialService,
    private readonly cipher: CredentialCipher,
    private readonly http: HttpClient,
  ) {
    const master = config.encryptionKeys[0].key;
    this.stateKey = Buffer.from(
      hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('oauth2-state:v1'), 32),
    );
  }

  get callbackUrl(): string {
    return `${this.config.baseUrl}/rest/oauth2/callback`;
  }

  private sign(payload: StatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.stateKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verifyState(state: string): StatePayload {
    const [body, mac] = state.split('.');
    if (!body || !mac) throw ApiError.badRequest('Invalid OAuth2 state');
    const expected = createHmac('sha256', this.stateKey).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw ApiError.badRequest('Invalid OAuth2 state');
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (payload.e < Date.now())
      throw ApiError.badRequest('The OAuth2 authorization expired, please try again');
    return payload;
  }

  private async loadOAuth2(tenantId: string, credentialId: string) {
    const row = await this.repos.credentials.get(tenantId, credentialId);
    if (!row) throw ApiError.notFound('Credential');
    if (!this.credentials.types.isA(row.type, 'oAuth2Api')) {
      throw ApiError.badRequest('This credential does not use OAuth2');
    }
    const data = this.credentials.withDefaults(row.type, this.credentials.decrypt(row));
    return { row, data };
  }

  async authorizeUrl(tenantId: string, userId: string, credentialId: string): Promise<string> {
    const { row, data } = await this.loadOAuth2(tenantId, credentialId);
    if (!data.authUrl || !data.clientId) {
      throw ApiError.badRequest('The credential needs an authorization URL and a client ID');
    }
    const url = new URL(String(data.authUrl));
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw ApiError.badRequest('Invalid authorization URL');
    const payload: StatePayload = {
      t: tenantId,
      c: row.id,
      u: userId,
      e: Date.now() + STATE_TTL_MS,
      n: randomBytes(12).toString('base64url'),
    };
    url.searchParams.set('client_id', String(data.clientId));
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('response_type', 'code');
    if (data.scope) url.searchParams.set('scope', String(data.scope));
    if (data.grantType === 'pkce') {
      const verifier = randomBytes(32).toString('base64url');
      payload.v = this.cipher.encrypt(verifier, { tenantId, credentialId: `${row.id}:pkce` });
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of new URLSearchParams(String(data.authQueryParameters ?? '')))
      url.searchParams.set(k, v);
    url.searchParams.set('state', this.sign(payload));
    return url.toString();
  }

  /** exchange the code and store the tokens; returns the credential id */
  async callback(code: string, state: string): Promise<{ tenantId: string; credentialId: string }> {
    const payload = this.verifyState(state);
    const membership = await this.repos.memberships.get(payload.t, payload.u);
    if (!membership || !hasRole(membership.role, 'editor')) {
      throw ApiError.forbidden('You can no longer edit credentials in this workspace');
    }
    const { row, data } = await this.loadOAuth2(payload.t, payload.c);
    if (!data.accessTokenUrl) throw ApiError.badRequest('The credential has no access token URL');
    // the code exchange is a token call of the credential: its allowed domains apply (the `none` mode does
    // not: the token URL is not a URL a user typed), here and on every redirect hop
    const allowedDomains = getCredentialAllowedDomains(data, { userUrl: false });
    try {
      assertCredentialUrlAllowed(String(data.accessTokenUrl), allowedDomains);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl,
    };
    if (payload.v) {
      body.code_verifier = this.cipher.decrypt<string>(payload.v, {
        tenantId: payload.t,
        credentialId: `${row.id}:pkce`,
      });
    }
    let auth: { username: string; password: string } | undefined;
    if (data.authentication === 'body' || data.grantType === 'pkce') {
      body.client_id = String(data.clientId ?? '');
      if (data.clientSecret) body.client_secret = String(data.clientSecret);
    } else {
      auth = { username: String(data.clientId ?? ''), password: String(data.clientSecret ?? '') };
    }
    const token = (await this.http.request({
      url: String(data.accessTokenUrl),
      method: 'POST',
      body,
      bodyType: 'form-urlencoded',
      headers: { accept: 'application/json' },
      auth,
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
    })) as DataObject;
    if (!token || typeof token !== 'object' || !token.access_token) {
      throw ApiError.badRequest('The token response did not contain an access token');
    }
    const stored = this.credentials.decrypt(row);
    stored.oauthTokenData = {
      ...token,
      expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : undefined,
    };
    await this.credentials.saveData(payload.t, row.id, stored);
    await this.repos.audit.add(payload.t, {
      userId: payload.u,
      action: 'credential.oauth2_connected',
      resourceType: 'credential',
      resourceId: row.id,
    });
    return { tenantId: payload.t, credentialId: row.id };
  }
}

/** same name as OAUTH2_CHANNEL in the editor's CredentialModal */
const OAUTH2_CHANNEL = 'wf-oauth2';

/**
 * HTML for the OAuth2 popup: notify the opener (same origin only) and close. The result is also
 * broadcast on a same-origin BroadcastChannel, because a provider's Cross-Origin-Opener-Policy
 * can cut the popup off from its opener.
 */
export function oauthCallbackPage(
  targetOrigin: string,
  nonce: string,
  message: { status: 'success' | 'error'; credentialId?: string; message?: string },
): string {
  const data = JSON.stringify({ type: 'oauth2-callback', ...message })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const origin = JSON.stringify(targetOrigin).replace(/</g, '\\u003c');
  const text = message.status === 'success' ? 'Connected. You can close this window.' : 'Connection failed.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth2</title></head><body><p>${text}</p><script nonce="${nonce}">
(function(){var d=${data};try{if(window.opener){window.opener.postMessage(d,${origin});}}catch(e){}try{var c=new BroadcastChannel(${JSON.stringify(OAUTH2_CHANNEL)});c.postMessage(d);c.close();}catch(e){}setTimeout(function(){window.close();},50);})();
</script></body></html>`;
}
