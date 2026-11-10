/**
 * OAuth1 (RFC 5849) three-legged sign-in, modelled on OAuth2Service. The HMAC-signed `state` (tenant,
 * credential, user, expiry, nonce) rides in the callback URL, which the request-token call must
 * sign before the provider has issued a token. So the request token and its secret cannot be
 * inside the state: they are kept for 10 minutes, the secret encrypted with the credential cipher,
 * in Redis (an in-process map without Redis) under the state nonce, and read once.
 * The state key uses its own HKDF info, so a state cannot cross into the OAuth2 flow.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialCipher, HttpClient } from '@workflow/core';
import { parseOAuthResponse, signOAuth1Request as sign } from '@workflow/nodes-base';
import { assertCredentialUrlAllowed, type DataObject, getCredentialAllowedDomains } from '@workflow/workflow';
import type { Redis } from 'ioredis';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import type { CredentialService } from './credentials';
import {
  assertPerUserCallback,
  NOT_PRIVATE_MESSAGE,
  type OAuthCallbackSession,
  PRIVATE_SHARED_CONNECT_MESSAGE,
} from './oauth2';
import { credentialReadErrorText } from './secrets/resolver';

const STATE_TTL_MS = 10 * 60_000;
type Method = NonNullable<Parameters<typeof sign>[1]['signatureMethod']>;

interface StatePayload {
  t: string; // tenant id
  c: string; // credential id
  u: string; // user id
  e: number; // expiry (epoch ms)
  n: string; // nonce, also the key of the stored request token
  p?: 1; // P6-15: the user's own connection of a private credential (the entry, not the shared row)
}

interface PendingToken {
  rt: string; // request token (public part)
  rs: string; // request-token secret, encrypted
}

export class OAuth1Service {
  private readonly stateKey: Buffer;
  private readonly pending = new Map<string, { value: PendingToken; expires: number }>();

  constructor(
    private readonly config: Config,
    private readonly repos: Repositories,
    private readonly credentials: CredentialService,
    private readonly cipher: CredentialCipher,
    private readonly http: HttpClient,
    private readonly redis?: Redis,
  ) {
    const master = config.encryptionKeys[0].key;
    this.stateKey = Buffer.from(
      hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from('oauth1-state:v1'), 32),
    );
  }

  get callbackUrl(): string {
    return `${this.config.baseUrl}/rest/oauth1/callback`;
  }

  private sign(payload: StatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.stateKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verifyState(state: string): StatePayload {
    const [body, mac] = state.split('.');
    if (!body || !mac) throw ApiError.badRequest('Invalid OAuth1 state');
    const expected = createHmac('sha256', this.stateKey).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw ApiError.badRequest('Invalid OAuth1 state');
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (payload.e < Date.now())
      throw ApiError.badRequest('The OAuth1 authorization expired, please try again');
    return payload;
  }

  private pendingKey(payload: StatePayload): string {
    return `${this.config.queue.prefix}:oauth1:${payload.t}:${payload.n}`;
  }

  private async keep(payload: StatePayload, value: PendingToken): Promise<void> {
    const key = this.pendingKey(payload);
    if (this.redis) {
      await this.redis.set(key, JSON.stringify(value), 'PX', STATE_TTL_MS);
      return;
    }
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(key, { value, expires: now + STATE_TTL_MS });
  }

  /** read once: the entry is gone afterwards */
  private async take(payload: StatePayload): Promise<PendingToken | undefined> {
    const key = this.pendingKey(payload);
    if (this.redis) {
      // GET + DEL in one transaction (GETDEL needs Redis 6.2 or later)
      const result = await this.redis.multi().get(key).del(key).exec();
      const raw = result?.[0]?.[1];
      return typeof raw === 'string' && raw ? (JSON.parse(raw) as PendingToken) : undefined;
    }
    const entry = this.pending.get(key);
    this.pending.delete(key);
    return entry && entry.expires >= Date.now() ? entry.value : undefined;
  }

  private async loadOAuth1(tenantId: string, credentialId: string) {
    const row = await this.repos.credentials.get(tenantId, credentialId);
    if (!row) throw ApiError.notFound('Credential');
    if (!this.credentials.types.isA(row.type, 'oAuth1Api')) {
      throw ApiError.badRequest('This credential does not use OAuth1');
    }
    // the read of `$secrets`; what `saveData` writes below is the stored object, never this one
    let data: DataObject;
    try {
      data = await this.credentials.readResolved(row);
    } catch (error) {
      throw ApiError.badRequest(credentialReadErrorText(error));
    }
    return { row, data };
  }

  /** one signed POST to a token endpoint; the form response as an object */
  private async tokenCall(
    url: string,
    data: DataObject,
    extra: { token?: string; tokenSecret?: string; callback?: string; verifier?: string },
  ): Promise<Record<string, string>> {
    // the credential's own token calls are not user-typed URLs; an empty or failing list is a 400
    let allowedDomains: ReturnType<typeof getCredentialAllowedDomains>;
    try {
      allowedDomains = getCredentialAllowedDomains(data, { userUrl: false });
      assertCredentialUrlAllowed(url, allowedDomains);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    const request = sign(
      {
        url,
        method: 'POST',
        responseType: 'text',
        headers: { accept: 'application/x-www-form-urlencoded, text/plain, */*' },
        allowedDomains,
      },
      {
        consumerKey: String(data.consumerKey ?? ''),
        consumerSecret: String(data.consumerSecret ?? ''),
        signatureMethod: (data.signatureMethod as Method | undefined) ?? 'HMAC-SHA1',
        ...extra,
      },
    );
    if (request.allowedDomains === undefined) delete request.allowedDomains;
    let body: unknown;
    try {
      body = await this.http.request(request);
    } catch (error) {
      throw ApiError.badRequest(tokenCallError(error));
    }
    return parseOAuthResponse(typeof body === 'string' ? body : '');
  }

  /**
   * step 1: request token, then the provider's authorization URL for the popup. `perUser` (P6-15): the
   * caller's own connection of a private credential, as OAuth2Service.authorizeUrl.
   */
  async authorizeUrl(
    tenantId: string,
    userId: string,
    credentialId: string,
    options: { perUser?: boolean } = {},
  ): Promise<string> {
    const { row, data } = await this.loadOAuth1(tenantId, credentialId);
    if (options.perUser && !row.isResolvable) throw ApiError.badRequest(NOT_PRIVATE_MESSAGE);
    if (!options.perUser && row.isResolvable) throw ApiError.badRequest(PRIVATE_SHARED_CONNECT_MESSAGE);
    if (!data.requestTokenUrl || !data.authUrl || !data.consumerKey) {
      throw ApiError.badRequest(
        'The credential needs a request token URL, an authorization URL and a consumer key',
      );
    }
    const authUrl = new URL(String(data.authUrl));
    if (authUrl.protocol !== 'https:' && authUrl.protocol !== 'http:')
      throw ApiError.badRequest('Invalid authorization URL');
    const payload: StatePayload = {
      t: tenantId,
      c: row.id,
      u: userId,
      e: Date.now() + STATE_TTL_MS,
      n: randomBytes(12).toString('base64url'),
      ...(options.perUser ? { p: 1 as const } : {}),
    };
    const callback = new URL(this.callbackUrl);
    callback.searchParams.set('state', this.sign(payload));
    const token = await this.tokenCall(String(data.requestTokenUrl), data, { callback: callback.toString() });
    if (!token.oauth_token || !token.oauth_token_secret) {
      throw ApiError.badRequest('The request token response did not contain a token');
    }
    await this.keep(payload, {
      rt: token.oauth_token,
      rs: this.cipher.encrypt(token.oauth_token_secret, { tenantId, credentialId: `${row.id}:oauth1` }),
    });
    authUrl.searchParams.set('oauth_token', token.oauth_token);
    return authUrl.toString();
  }

  /**
   * step 2: the provider sent the user back; trade the verifier for the access token. `session` (P6-15): a
   * per user state is refused unless the callback's signed-in user is the state's.
   */
  async callback(
    query: { oauth_token?: string; oauth_verifier?: string; denied?: string },
    state: string,
    session?: OAuthCallbackSession,
  ): Promise<{ tenantId: string; credentialId: string }> {
    const payload = this.verifyState(state);
    if (payload.p) {
      await assertPerUserCallback(this.credentials, this.repos, payload, session);
    } else if (!(await this.credentials.userMayUpdate(payload.t, payload.u, payload.c))) {
      // P6-24: the user of the state must still hold `credential:update` on this credential (a lost project, a
      // removed member or a narrowed role refuses the write-back before any token call)
      throw ApiError.forbidden('You can no longer edit credentials in this workspace');
    }
    if (query.denied || !query.oauth_verifier || !query.oauth_token) {
      throw ApiError.badRequest('The authorization was not granted');
    }
    const { row, data } = await this.loadOAuth1(payload.t, payload.c);
    if (!data.accessTokenUrl) throw ApiError.badRequest('The credential has no access token URL');
    const pending = await this.take(payload);
    if (!pending)
      throw ApiError.badRequest('The authorization expired or was already used, please try again');
    if (query.oauth_token !== pending.rt) throw ApiError.badRequest('The request token does not match');
    const secret = this.cipher.decrypt<string>(pending.rs, {
      tenantId: payload.t,
      credentialId: `${row.id}:oauth1`,
    });
    const token = await this.tokenCall(String(data.accessTokenUrl), data, {
      token: pending.rt,
      tokenSecret: secret,
      verifier: query.oauth_verifier,
    });
    if (!token.oauth_token || !token.oauth_token_secret) {
      throw ApiError.badRequest('The access token response did not contain a token');
    }
    if (payload.p) {
      // P6-15: the user's own entry; the shared row keeps no token
      await this.credentials.saveEntry(payload.t, row.id, payload.u, { oauthTokenData: { ...token } });
    } else {
      const stored = this.credentials.decrypt(row);
      stored.oauthTokenData = { ...token };
      await this.credentials.saveData(payload.t, row.id, stored);
    }
    await this.repos.audit.add(payload.t, {
      userId: payload.u,
      action: payload.p ? 'credential.user_connected' : 'credential.oauth1_connected',
      resourceType: 'credential',
      resourceId: row.id,
    });
    return { tenantId: payload.t, credentialId: row.id };
  }
}

/**
 * A fixed message for a failed token call: the HTTP status and the provider's oauth_problem code
 * when it sends one, or the domain / SSRF refusal (these name the host only). Never the raw client
 * message, which can carry the URL.
 */
function tokenCallError(error: unknown): string {
  const e = error as { name?: string; message?: string; statusCode?: unknown; body?: unknown };
  if (e?.name === 'CredentialDomainError' || e?.name === 'SsrfBlockedError') return String(e.message);
  if (typeof e?.statusCode === 'number') {
    const body = typeof e.body === 'string' ? e.body : '';
    const problem = /(?:^|&)oauth_problem=([A-Za-z0-9_]{1,64})(?:&|$)/.exec(body.trim())?.[1];
    return `The provider rejected the request (HTTP ${e.statusCode}${problem ? `, ${problem}` : ''})`;
  }
  return 'The provider could not be reached';
}
