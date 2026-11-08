/**
 * Phase 5 S4 contract step C0c: OAuth2 for the MCP client (findings 5 and 6) and the MCP auth seam of the
 * webhook context. `requestOAuth2Token` sends `client_secret` only when set and `resource` when the credential
 * has a `resourceUrl`; `oauth2Request` refreshes and retries once on a 401 full response (the MCP client posts
 * with `returnFullResponse` and `ignoreHttpStatusErrors`, so no error is thrown); a token error still throws.
 */
import {
  ExpressionEvaluator,
  type HttpRequestOptions,
  type McpAuthHelper,
  type WebhookRequest,
  Workflow,
} from '@workflow/workflow';
import { describe, expect, it, vi } from 'vitest';
import {
  type ContextDeps,
  createWebhookContext,
  type ExecutionServices,
  type HttpClient,
  HttpError,
  type OAuth2Data,
  oauth2Request,
  requestOAuth2Token,
} from '../src';
import { node, nodeTypes, services } from './helpers';

const TOKEN_URL = 'https://auth.example.com/token';

/** an HttpClient that answers each call with the next entry of `replies` (an Error entry is thrown) */
function scriptedHttp(replies: unknown[]) {
  const queue = [...replies];
  const request = vi.fn(async (_options: HttpRequestOptions, _signal?: AbortSignal) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    client: { request } as unknown as HttpClient,
    request,
    sent: () => request.mock.calls.map((call) => call[0]),
  };
}

const full = (statusCode: number, body: unknown = '') => ({
  body,
  headers: {},
  statusCode,
  statusMessage: '',
});

const pkce = (extra: Partial<OAuth2Data> = {}): OAuth2Data => ({
  grantType: 'pkce',
  clientId: 'client-1',
  accessTokenUrl: TOKEN_URL,
  authentication: 'body',
  oauthTokenData: { access_token: 'old-access', refresh_token: 'old-refresh' },
  ...extra,
});

const mcpPost: HttpRequestOptions = {
  url: 'https://mcp.example.com/mcp',
  method: 'POST',
  body: '{}',
  bodyType: 'raw',
  responseType: 'text',
  returnFullResponse: true,
  ignoreHttpStatusErrors: true,
};

const bodyOf = (options: HttpRequestOptions | undefined) => options?.body as Record<string, string>;

describe('requestOAuth2Token (finding 6)', () => {
  it('sends no client_secret for a public client', async () => {
    const http = scriptedHttp([{ access_token: 'new' }]);
    await requestOAuth2Token(http.client, pkce(), { type: 'refresh_token', refreshToken: 'r1' });
    const body = bodyOf(http.sent()[0]);
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'client-1' });
    expect('client_secret' in body).toBe(false);
  });

  it('sends client_secret when it is set', async () => {
    const http = scriptedHttp([{ access_token: 'new' }]);
    await requestOAuth2Token(http.client, pkce({ clientSecret: 's3cret' }), {
      type: 'refresh_token',
      refreshToken: 'r1',
    });
    expect(bodyOf(http.sent()[0]).client_secret).toBe('s3cret');
  });

  it('sends resource when resourceUrl is set, on refresh and on client credentials', async () => {
    const http = scriptedHttp([{ access_token: 'a' }, { access_token: 'b' }]);
    const data = pkce({ resourceUrl: 'https://mcp.example.com/mcp' });
    await requestOAuth2Token(http.client, data, { type: 'refresh_token', refreshToken: 'r1' });
    await requestOAuth2Token(
      http.client,
      { ...data, grantType: 'clientCredentials' },
      { type: 'client_credentials' },
    );
    expect(bodyOf(http.sent()[0]).resource).toBe('https://mcp.example.com/mcp');
    expect(bodyOf(http.sent()[1]).resource).toBe('https://mcp.example.com/mcp');
  });

  it('sends no resource without resourceUrl', async () => {
    const http = scriptedHttp([{ access_token: 'a' }]);
    await requestOAuth2Token(http.client, pkce(), { type: 'refresh_token', refreshToken: 'r1' });
    expect('resource' in bodyOf(http.sent()[0])).toBe(false);
  });

  it('keeps basic auth in header mode', async () => {
    const http = scriptedHttp([{ access_token: 'a' }]);
    await requestOAuth2Token(http.client, pkce({ authentication: 'header', clientSecret: 's3cret' }), {
      type: 'refresh_token',
      refreshToken: 'r1',
    });
    expect(http.sent()[0]?.auth).toEqual({ username: 'client-1', password: 's3cret' });
    expect('client_secret' in bodyOf(http.sent()[0])).toBe(false);
  });
});

describe('oauth2Request 401 on a full response (finding 5)', () => {
  it('refreshes and retries once, and reports the new token', async () => {
    const http = scriptedHttp([
      full(401),
      { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
      full(200, 'ok'),
    ]);
    const saved: OAuth2Data[] = [];
    const response = await oauth2Request<{ statusCode: number; body: unknown }>(
      http.client,
      pkce({ resourceUrl: 'https://mcp.example.com/mcp' }),
      mcpPost,
      async (data) => {
        saved.push(data);
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
    const sent = http.sent();
    expect(sent).toHaveLength(3);
    expect(sent[0]?.headers?.authorization).toBe('Bearer old-access');
    expect(sent[1]?.url).toBe(TOKEN_URL);
    expect(bodyOf(sent[1])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      resource: 'https://mcp.example.com/mcp',
    });
    expect(sent[2]?.headers?.authorization).toBe('Bearer new-access');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.oauthTokenData?.access_token).toBe('new-access');
    expect(saved[0]?.oauthTokenData?.refresh_token).toBe('new-refresh');
  });

  it('releases the unread streamed body of the first 401 before the retry', async () => {
    let cancelled = false;
    // like HttpClient's streamed body: an unstarted generator that cancels its reader in `finally`
    async function* unread() {
      try {
        yield new Uint8Array([1]);
        yield new Uint8Array([2]);
      } finally {
        cancelled = true;
      }
    }
    const http = scriptedHttp([full(401, unread()), { access_token: 'new-access' }, full(200, 'ok')]);
    const response = await oauth2Request<{ statusCode: number }>(
      http.client,
      pkce(),
      { ...mcpPost, method: 'GET', responseType: 'stream' },
      async () => {},
    );
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('retries only once: a second 401 is returned as it is', async () => {
    const http = scriptedHttp([full(401), { access_token: 'new-access' }, full(401, 'still no')]);
    const response = await oauth2Request<{ statusCode: number }>(
      http.client,
      pkce(),
      mcpPost,
      async () => {},
    );
    expect(response.statusCode).toBe(401);
    expect(http.request).toHaveBeenCalledTimes(3);
  });

  it('returns the 401 unchanged without a refresh token', async () => {
    const http = scriptedHttp([full(401, 'denied')]);
    const onRefresh = vi.fn(async () => {});
    const response = await oauth2Request<{ statusCode: number; body: unknown }>(
      http.client,
      pkce({ oauthTokenData: { access_token: 'only-access' } }),
      mcpPost,
      onRefresh,
    );
    expect(response).toMatchObject({ statusCode: 401, body: 'denied' });
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh on a 401 full response unless both options are set', async () => {
    const http = scriptedHttp([full(401)]);
    const response = await oauth2Request<{ statusCode: number }>(
      http.client,
      pkce(),
      { ...mcpPost, ignoreHttpStatusErrors: false },
      async () => {},
    );
    expect(response.statusCode).toBe(401);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('passes other statuses through without a refresh', async () => {
    const http = scriptedHttp([full(403, 'forbidden')]);
    const response = await oauth2Request<{ statusCode: number }>(
      http.client,
      pkce(),
      mcpPost,
      async () => {},
    );
    expect(response.statusCode).toBe(403);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('still throws a token error, and does not retry it', async () => {
    const tokenError = new HttpError(
      'Request failed with status code 400',
      400,
      'Bad Request',
      { error: 'invalid_grant' },
      {},
    );
    const http = scriptedHttp([full(401), tokenError]);
    const onRefresh = vi.fn(async () => {});
    await expect(oauth2Request(http.client, pkce(), mcpPost, onRefresh)).rejects.toBe(tokenError);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a token error answered 401 is not retried either', async () => {
    const tokenError = new HttpError('Request failed with status code 401', 401, 'Unauthorized', {}, {});
    const http = scriptedHttp([full(401), tokenError]);
    await expect(oauth2Request(http.client, pkce(), mcpPost, async () => {})).rejects.toBe(tokenError);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('a token response without access_token still throws', async () => {
    const http = scriptedHttp([full(401), { error: 'invalid_grant' }]);
    await expect(oauth2Request(http.client, pkce(), mcpPost, async () => {})).rejects.toThrow(
      'did not contain an access_token',
    );
  });

  it('keeps the thrown-401 refresh of a normal request', async () => {
    const http = scriptedHttp([
      new HttpError('Request failed with status code 401', 401, 'Unauthorized', {}, {}),
      { access_token: 'new-access' },
      { ok: true },
    ]);
    const result = await oauth2Request(
      http.client,
      pkce(),
      { url: 'https://api.example.com/x', method: 'GET' },
      async () => {},
    );
    expect(result).toEqual({ ok: true });
    expect(http.sent()[2]?.headers?.authorization).toBe('Bearer new-access');
  });
});

describe('MCP auth on the webhook context', () => {
  const request: WebhookRequest = { method: 'POST', headers: {}, query: {}, params: {}, body: {} };

  const contextWith = (overrides: Partial<ExecutionServices>) => {
    const set = node('Set', 'test.set');
    const deps: ContextDeps = {
      workflow: new Workflow({ name: 'w', connections: {}, nodes: [set] }, nodeTypes),
      node: set,
      services: services(overrides),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    };
    return createWebhookContext(deps, request, 'default');
  };

  it('getMcpAuth returns the services helper', () => {
    const helper: McpAuthHelper = {
      verifyAccessToken: async () => null,
      canExecute: async () => false,
      challenge: (resource) => `Bearer resource_metadata="${resource}"`,
    };
    expect(contextWith({ mcpAuth: helper }).getMcpAuth?.()).toBe(helper);
  });

  it('getMcpAuth is undefined without the helper', () => {
    expect(contextWith({}).getMcpAuth?.()).toBeUndefined();
  });
});
