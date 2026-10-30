/**
 * Apply credentials to outgoing requests: generic (header/query/body/basic) templates,
 * custom authenticate functions, and OAuth2 bearer tokens with automatic refresh.
 */
import {
  type CredentialType,
  type DataObject,
  evaluateSimple,
  type HttpRequestOptions,
  isExpression,
} from '@workflow/workflow';
import type { HttpClient } from '../http/http-client';
import { HttpError } from '../http/http-client';

export interface OAuth2Data extends DataObject {
  grantType?: 'authorizationCode' | 'clientCredentials' | 'pkce';
  clientId?: string;
  clientSecret?: string;
  accessTokenUrl?: string;
  authUrl?: string;
  scope?: string;
  authentication?: 'header' | 'body';
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
): Promise<HttpRequestOptions> {
  const auth = type.authenticate;
  if (!auth) return request;
  if (typeof auth === 'function') return auth(credentials, { ...request });
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

/** Fetch a token with the client-credentials grant or refresh an existing token. */
export async function requestOAuth2Token(
  http: HttpClient,
  data: OAuth2Data,
  grant: { type: 'refresh_token'; refreshToken: string } | { type: 'client_credentials' },
  signal?: AbortSignal,
): Promise<NonNullable<OAuth2Data['oauthTokenData']>> {
  if (!data.accessTokenUrl) throw new Error('OAuth2 credential has no access token URL');
  const body: Record<string, string> =
    grant.type === 'refresh_token'
      ? { grant_type: 'refresh_token', refresh_token: grant.refreshToken }
      : { grant_type: 'client_credentials', ...(data.scope ? { scope: data.scope } : {}) };
  const headers: Record<string, string> = { accept: 'application/json' };
  let auth: HttpRequestOptions['auth'];
  if (data.authentication === 'body') {
    body.client_id = data.clientId ?? '';
    body.client_secret = data.clientSecret ?? '';
  } else {
    auth = { username: data.clientId ?? '', password: data.clientSecret ?? '' };
  }
  const token = (await http.request(
    { url: data.accessTokenUrl, method: 'POST', body, bodyType: 'form-urlencoded', headers, auth },
    signal,
  )) as Record<string, unknown>;
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
 * reports the new token data through `onTokenRefresh` so it can be persisted.
 */
export async function oauth2Request<T>(
  http: HttpClient,
  data: OAuth2Data,
  request: HttpRequestOptions,
  onTokenRefresh: (data: OAuth2Data) => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  let tokenData = data.oauthTokenData;
  const refresh = async () => {
    if (tokenData?.refresh_token) {
      tokenData = await requestOAuth2Token(
        http,
        data,
        { type: 'refresh_token', refreshToken: tokenData.refresh_token },
        signal,
      );
    } else if (data.grantType === 'clientCredentials') {
      tokenData = await requestOAuth2Token(http, data, { type: 'client_credentials' }, signal);
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
  try {
    return (await http.request<T>(withToken(), signal)) as T;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 401) {
      await refresh();
      return (await http.request<T>(withToken(), signal)) as T;
    }
    throw error;
  }
}
