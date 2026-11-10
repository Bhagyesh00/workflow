/**
 * Apply credentials to outgoing requests: generic (header/query/body/basic) templates,
 * custom authenticate functions, and OAuth2 bearer tokens with automatic refresh.
 */
import {
  assertCredentialUrlAllowed,
  type CredentialAuthHelpers,
  type CredentialType,
  type DataObject,
  evaluateSimple,
  getCredentialAllowedDomains,
  type HttpRequestOptions,
  isExpression,
} from '@workflow/workflow';
import type { HttpClient } from '../http/http-client';
import { HttpError } from '../http/http-client';
import { signAwsRequest } from './aws-sigv4';
import { clientCredentialsRequest, parseAccessToken } from './azure-token';
import { GOOGLE_TOKEN_URL, googleJwtAssertion, jwtBearerRequest } from './google-jwt';
import { sharedTokenCache } from './token-cache';

export interface OAuth2Data extends DataObject {
  grantType?: 'authorizationCode' | 'clientCredentials' | 'pkce';
  clientId?: string;
  clientSecret?: string;
  accessTokenUrl?: string;
  authUrl?: string;
  scope?: string;
  authentication?: 'header' | 'body';
  /** `'true'`: a token call only goes to an https URL. A credential type fixes it with a hidden field. */
  httpsOnlyTokenUrl?: string;
  /** RFC 8707 resource indicator: sent as `resource` on every token call when set (MCP OAuth binds the token to it) */
  resourceUrl?: string;
  oauthTokenData?: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    token_type?: string;
    [key: string]: unknown;
  };
}

function resolveTemplate(value: string, credentials: DataObject): string {
  if (!isExpression(value)) return value;
  return String(evaluateSimple(value, { $credentials: credentials }) ?? '');
}

/** a credential's URL field with `={{$credentials.host}}/path` resolved; plain text stays as it is */
export function resolveCredentialUrl(value: string, data: DataObject): string {
  return resolveTemplate(value, data);
}

function resolveRecord(record: Record<string, string> | undefined, credentials: DataObject) {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [
      resolveTemplate(k, credentials),
      resolveTemplate(v, credentials),
    ]),
  );
}

export async function applyAuthentication(
  type: CredentialType,
  credentials: DataObject,
  request: HttpRequestOptions,
  helpers?: CredentialAuthHelpers,
): Promise<HttpRequestOptions> {
  const auth = type.authenticate;
  if (!auth) return request;
  if (typeof auth === 'function') return auth(credentials, { ...request }, helpers);
  const p = auth.properties;
  const next: HttpRequestOptions = { ...request };
  if (p.headers) next.headers = { ...(request.headers ?? {}), ...resolveRecord(p.headers, credentials) };
  if (p.qs) next.qs = { ...(request.qs ?? {}), ...resolveRecord(p.qs, credentials) };
  if (p.body) {
    next.body = {
      ...((request.body as DataObject | undefined) ?? {}),
      ...resolveRecord(p.body, credentials),
    };
  }
  if (p.auth) {
    next.auth = {
      username: resolveTemplate(p.auth.username, credentials),
      password: resolveTemplate(p.auth.password, credentials),
    };
  }
  return next;
}

/**
 * What a function `authenticate` may use. Every call goes through the guarded client with the credential's
 * allowed domains: checked here before anything is sent, and by HttpClient on every redirect hop.
 */
export function createCredentialHelpers(
  http: HttpClient,
  allowedDomains: string[] | undefined,
  signal?: AbortSignal,
): CredentialAuthHelpers {
  const call = async <T = unknown>(request: HttpRequestOptions): Promise<T> => {
    assertCredentialUrlAllowed(request.url, allowedDomains);
    const scoped = allowedDomains === undefined ? request : { ...request, allowedDomains };
    return (await http.request<T>(scoped, signal)) as T;
  };
  return {
    http: call,
    signAwsV4: (input) => ({ headers: signAwsRequest(input).headers }),
    jwtBearerToken: async (input) => {
      const assertion = googleJwtAssertion(input);
      return parseAccessToken(await call(jwtBearerRequest(assertion, input.tokenUrl ?? GOOGLE_TOKEN_URL)));
    },
    clientCredentialsToken: async (input) => parseAccessToken(await call(clientCredentialsRequest(input))),
    cachedToken: (secret, scope, fetch) => sharedTokenCache.get(secret, scope, fetch),
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Turns a token endpoint's parsed answer into the plain token (P6-16 JWE: decrypts the encrypted
 * parts when the credential asks for it, refuses a plain answer then). Runs before the
 * `access_token` check; its throw reaches the caller.
 */
export type OAuthTokenDecrypt = (token: DataObject, data: DataObject) => Promise<DataObject>;

/** Fetch a token with the client-credentials grant or refresh an existing token. */
export async function requestOAuth2Token(
  http: HttpClient,
  data: OAuth2Data,
  grant: { type: 'refresh_token'; refreshToken: string } | { type: 'client_credentials' },
  signal?: AbortSignal,
  decryptToken?: OAuthTokenDecrypt,
): Promise<NonNullable<OAuth2Data['oauthTokenData']>> {
  if (!data.accessTokenUrl) throw new Error('OAuth2 credential has no access token URL');
  const accessTokenUrl = resolveCredentialUrl(data.accessTokenUrl, data);
  if (!accessTokenUrl) throw new Error('OAuth2 credential has no access token URL');
  if (data.httpsOnlyTokenUrl === 'true' && !isHttpsUrl(accessTokenUrl)) {
    throw new Error("Couldn't get a token: this credential's access token URL must use https");
  }
  // the credential's own token calls honour its allowed domains too (the token URL is not typed by the
  // user of a node, so the `none` mode does not apply). No redirect is followed: a 307 would carry the
  // refresh token and the secret to the next host, and a 3xx answer ends in the missing token error below.
  const allowedDomains = getCredentialAllowedDomains(data, { userUrl: false });
  assertCredentialUrlAllowed(accessTokenUrl, allowedDomains);
  const body: Record<string, string> =
    grant.type === 'refresh_token'
      ? { grant_type: 'refresh_token', refresh_token: grant.refreshToken }
      : { grant_type: 'client_credentials', ...(data.scope ? { scope: data.scope } : {}) };
  const resource = data.resourceUrl ? resolveCredentialUrl(data.resourceUrl, data) : '';
  if (resource) body.resource = resource;
  const headers: Record<string, string> = { accept: 'application/json' };
  let auth: HttpRequestOptions['auth'];
  if (data.authentication === 'body') {
    body.client_id = data.clientId ?? '';
    // a public client (dynamic registration, PKCE) has no secret: an empty `client_secret=` fails its refresh
    if (data.clientSecret) body.client_secret = data.clientSecret;
  } else {
    auth = { username: data.clientId ?? '', password: data.clientSecret ?? '' };
  }
  let token = (await http.request(
    {
      url: accessTokenUrl,
      method: 'POST',
      body,
      bodyType: 'form-urlencoded',
      headers,
      auth,
      followRedirects: false,
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
    },
    signal,
  )) as Record<string, unknown>;
  if (decryptToken) token = await decryptToken(token, data);
  if (!token.access_token) throw new Error('OAuth2 token response did not contain an access_token');
  return {
    ...token,
    access_token: String(token.access_token),
    refresh_token:
      (token.refresh_token as string | undefined) ??
      (grant.type === 'refresh_token' ? grant.refreshToken : undefined),
    expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : undefined,
  };
}

/**
 * Perform an OAuth2-authenticated request; refreshes the token when expired or on 401 and
 * reports the new token data through `onTokenRefresh` so it can be persisted. A request with
 * `returnFullResponse` and `ignoreHttpStatusErrors` (the MCP client) gets no thrown error on a 401:
 * when its status is 401 and a refresh token exists, the token is refreshed and the request retried once;
 * without a refresh token the 401 response is returned unchanged.
 */
export async function oauth2Request<T>(
  http: HttpClient,
  data: OAuth2Data,
  request: HttpRequestOptions,
  onTokenRefresh: (data: OAuth2Data) => Promise<void>,
  signal?: AbortSignal,
  decryptToken?: OAuthTokenDecrypt,
): Promise<T> {
  let tokenData = data.oauthTokenData;
  const refresh = async () => {
    if (tokenData?.refresh_token) {
      tokenData = await requestOAuth2Token(
        http,
        data,
        { type: 'refresh_token', refreshToken: tokenData.refresh_token },
        signal,
        decryptToken,
      );
    } else if (data.grantType === 'clientCredentials') {
      tokenData = await requestOAuth2Token(http, data, { type: 'client_credentials' }, signal, decryptToken);
    } else {
      throw new Error(
        'OAuth2 credential is not connected or has no refresh token. Reconnect the credential.',
      );
    }
    await onTokenRefresh({ ...data, oauthTokenData: tokenData });
  };

  if (!tokenData?.access_token || (tokenData.expires_at && tokenData.expires_at - 30_000 < Date.now())) {
    await refresh();
  }
  const withToken = (): HttpRequestOptions => ({
    ...request,
    headers: { ...(request.headers ?? {}), authorization: `Bearer ${tokenData!.access_token}` },
  });
  let response: unknown;
  try {
    response = await http.request<T>(withToken(), signal);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 401) {
      await refresh();
      return (await http.request<T>(withToken(), signal)) as T;
    }
    throw error;
  }
  // outside the try: a failing token call during this refresh throws as it is, and is not retried
  if (
    request.returnFullResponse &&
    request.ignoreHttpStatusErrors &&
    (response as { statusCode?: unknown } | null)?.statusCode === 401 &&
    tokenData?.refresh_token
  ) {
    releaseBody((response as { body?: unknown }).body);
    await refresh();
    return (await http.request<T>(withToken(), signal)) as T;
  }
  return response as T;
}

/**
 * Let go of an unread streamed body (the 401 answer before a retry), so its connection is freed now and not
 * at garbage collection. `return()` on an unstarted generator skips its `finally`, where the body is
 * cancelled: one `next()` starts it first. Not awaited, so a server that never sends a byte delays nothing.
 */
function releaseBody(body: unknown): void {
  if (typeof body !== 'object' || body === null || !(Symbol.asyncIterator in body)) return;
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  void iterator
    .next()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}
