/**
 * OAuth2 authorization-code flow (ARCHITECTURE.md §9). The `state` parameter is an HMAC-signed,
 * tenant-bound token with a 10 minute TTL; the PKCE verifier travels inside it encrypted with
 * the credential cipher, so nothing has to be stored server-side between the two requests and
 * nothing secret is visible in the browser.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { type CredentialCipher, type HttpClient, resolveCredentialUrl } from '@workflow/core';
import {
  assertCredentialUrlAllowed,
  CredentialDomainError,
  type DataObject,
  getCredentialAllowedDomains,
} from '@workflow/workflow';
import type { Config } from '../config';
import type { CredentialRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';
import { hasRole } from './auth';
import type { CredentialService } from './credentials';
import { MCP_OAUTH2_TYPE, McpDiscoveryError, McpOAuthDiscovery, mcpClientMetadata } from './oauth2-discovery';
import { credentialReadErrorText } from './secrets/resolver';

const STATE_TTL_MS = 10 * 60_000;

/** the credential type whose token calls carry the client secret to a host the user typed: https only */
const HTTPS_ONLY_TYPE = 'databricksOAuth2Api';

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

  /** P5-18: the public Client ID Metadata Document of this instance (no secret in it) */
  clientMetadata(): Record<string, unknown> {
    return mcpClientMetadata(this.config.baseUrl, this.callbackUrl);
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
    // the read of `$secrets`; what `saveData` writes below is the stored object, never this one
    let data: DataObject;
    try {
      data = await this.credentials.readResolved(row);
    } catch (error) {
      throw ApiError.badRequest(credentialReadErrorText(error));
    }
    return { row, data };
  }

  /**
   * A URL of the flow. Only a template the type itself fixes, such as `={{$credentials.host}}/oidc/...`, is
   * resolved here: a typed value was resolved when it was read, and a second pass would expose stored
   * secrets. The https-only type refuses any other scheme.
   */
  private flowUrl(
    type: string,
    data: DataObject,
    field: 'authUrl' | 'accessTokenUrl',
    label: string,
  ): string {
    let resolved: string;
    try {
      const raw = String(data[field] ?? '');
      const fixed = this.credentials.types
        .getResolved(type)
        ?.properties.some((p) => p.name === field && p.type === 'hidden' && p.default !== '');
      resolved = fixed ? resolveCredentialUrl(raw, data) : raw;
    } catch {
      throw ApiError.badRequest(`Invalid ${label}`);
    }
    if (this.credentials.types.isA(type, HTTPS_ONLY_TYPE)) {
      const isHttps = (value: string): boolean => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      };
      if (!isHttps(resolved) || !isHttps(String(data.host ?? ''))) {
        throw ApiError.badRequest(`The ${label} must use https for this credential`);
      }
    }
    return resolved;
  }

  /**
   * P5-18: an MCP OAuth2 credential with automatic registration finds its authorization server from its
   * resource URL and becomes its client again on every Connect (RFC 9728, RFC 8414, then CIMD or RFC 7591,
   * all in oauth2-discovery.ts on the guarded client). The found URLs and the client go into the stored
   * credential through `saveData`; the returned data is the read this authorize URL is built from.
   * Tokens already stored stay until the callback replaces them.
   */
  private async connectMcpClient(
    tenantId: string,
    row: CredentialRow,
    data: DataObject,
  ): Promise<DataObject> {
    const resourceUrl = String(data.resourceUrl ?? '').trim();
    if (!resourceUrl) {
      throw ApiError.badRequest('The credential needs a resource URL: the endpoint of the MCP server');
    }
    try {
      const discovery = new McpOAuthDiscovery(
        this.http,
        getCredentialAllowedDomains(data, { userUrl: false }),
      );
      const server = await discovery.discover(resourceUrl);
      const scope = String(data.scope ?? '').trim() || server.scopesSupported.join(' ');
      const client = await discovery.client(server, {
        baseUrl: this.config.baseUrl,
        callbackUrl: this.callbackUrl,
        scope: scope || undefined,
      });
      const found: DataObject = {
        authUrl: server.authorizationEndpoint,
        accessTokenUrl: server.tokenEndpoint,
        clientId: client.clientId,
        authentication: client.authentication,
      };
      const stored = { ...this.credentials.decrypt(row), ...found };
      if (client.clientSecret) stored.clientSecret = client.clientSecret;
      else delete stored.clientSecret;
      await this.credentials.saveData(tenantId, row.id, stored);
      const next: DataObject = { ...data, ...found, scope };
      if (client.clientSecret) next.clientSecret = client.clientSecret;
      else delete next.clientSecret;
      return next;
    } catch (error) {
      // these texts name a host or a rule, never a secret or a response body
      if (error instanceof McpDiscoveryError || error instanceof CredentialDomainError) {
        throw ApiError.badRequest(error.message);
      }
      throw ApiError.badRequest("Couldn't find the authorization server of the MCP server");
    }
  }

  async authorizeUrl(tenantId: string, userId: string, credentialId: string): Promise<string> {
    const loaded = await this.loadOAuth2(tenantId, credentialId);
    const { row } = loaded;
    let { data } = loaded;
    const mcp = this.credentials.types.isA(row.type, MCP_OAUTH2_TYPE);
    if (mcp && data.useDynamicClientRegistration !== false) {
      data = await this.connectMcpClient(tenantId, row, data);
    }
    if (!data.authUrl || !data.clientId) {
      throw ApiError.badRequest('The credential needs an authorization URL and a client ID');
    }
    if (this.credentials.types.isA(row.type, HTTPS_ONLY_TYPE) && data.grantType !== 'pkce') {
      throw ApiError.badRequest('This grant type gets its token without Connect');
    }
    let url: URL;
    try {
      url = new URL(this.flowUrl(row.type, data, 'authUrl', 'authorization URL'));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.badRequest('Invalid authorization URL');
    }
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
    // RFC 8707: the MCP server the token is for, on the authorize call as on every token call
    const resource = mcp ? String(data.resourceUrl ?? '').trim() : '';
    if (resource) url.searchParams.set('resource', resource);
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
    const accessTokenUrl = this.flowUrl(row.type, data, 'accessTokenUrl', 'access token URL');
    if (!accessTokenUrl) throw ApiError.badRequest('The credential has no access token URL');
    const allowedDomains = getCredentialAllowedDomains(data, { userUrl: false });
    try {
      assertCredentialUrlAllowed(accessTokenUrl, allowedDomains);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl,
    };
    if (this.credentials.types.isA(row.type, MCP_OAUTH2_TYPE)) {
      const resource = String(data.resourceUrl ?? '').trim();
      if (resource) body.resource = resource;
    }
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
      url: accessTokenUrl,
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
