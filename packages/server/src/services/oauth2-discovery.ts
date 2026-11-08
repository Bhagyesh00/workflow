/**
 * P5-18: how an MCP OAuth2 credential (`mcpOAuth2Api`) finds its authorization server and becomes a
 * client of it, before the ordinary authorization-code flow of services/oauth2.ts runs.
 *
 * 1. RFC 9728: the protected resource metadata of the credential's `resourceUrl` (path insertion first,
 *    then the root document) names the authorization server (its issuer).
 * 2. RFC 8414 and OpenID Connect discovery: the metadata of that issuer; its `issuer` must be the one asked
 *    for, it must state `S256` for PKCE, and every endpoint must be https (http only on a loopback host).
 * 3. The client: a Client ID Metadata Document (our public URL is the client id) when the server states
 *    support and our base URL is https, else RFC 7591 dynamic registration with our callback URL.
 *
 * Every request goes through the server's guarded HttpClient with the credential's allowed domains, so the
 * SSRF policy applies and a redirect to a host outside the list is refused. Nothing secret is sent in a
 * discovery or registration request, and no error here quotes a secret or a response body.
 */
import { type HttpClient, SsrfBlockedError } from '@workflow/core';
import { assertCredentialUrlAllowed, CredentialDomainError, type HttpFullResponse } from '@workflow/workflow';

/** the credential type this module serves */
export const MCP_OAUTH2_TYPE = 'mcpOAuth2Api';

/** the public route of our Client ID Metadata Document, under the base URL */
export const MCP_CLIENT_METADATA_PATH = '/rest/oauth2/mcp-client-metadata';

/** the name we register under */
export const MCP_CLIENT_NAME = 'Workflow';

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_CLIENT_ID_LENGTH = 2048;

/** what discovery found; only these values are stored on the credential */
export interface McpAuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** the server accepts a Client ID Metadata Document URL as client id */
  clientIdMetadataDocumentSupported: boolean;
  /** scopes the protected resource states (used when the credential has none) */
  scopesSupported: string[];
}

/** the client we got: a registered client, or our metadata document URL */
export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** how the token call sends the client: `body` (public client and `client_secret_post`) or `header` (basic) */
  authentication: 'body' | 'header';
  via: 'cimd' | 'registration';
}

/** an error whose message is safe to show (no secret, no response body) */
export class McpDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpDiscoveryError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '::1']);

/** a loopback host name as `new URL(x).hostname` gives it: localhost, 127.0.0.0/8 or ::1 (exact names, no suffix test) */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * `value` as an absolute URL that is https, or http on a loopback host only; anything else throws.
 * No query-less check: RFC 8414 endpoints may carry a query.
 */
export function requireSecureUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new McpDiscoveryError(`The ${label} is missing`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpDiscoveryError(`The ${label} is not a valid URL`);
  }
  if (url.username || url.password) throw new McpDiscoveryError(`The ${label} must not contain a user name`);
  if (url.hash) throw new McpDiscoveryError(`The ${label} must not contain a fragment`);
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.toString();
  throw new McpDiscoveryError(`The ${label} must use https (http is allowed only on a loopback host)`);
}

/** `a` and `b` name the same URL, ignoring one trailing slash */
function sameUrl(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/\/$/, '');
  return strip(a) === strip(b);
}

/** the URL with the path of `base` inserted after `/.well-known/<name>` (RFC 8414 3.1, RFC 9728 3.1) */
function wellKnownInserted(base: URL, name: string): string {
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return `${base.origin}/.well-known/${name}${path}`;
}

/** the URL with `/.well-known/<name>` appended to the path of `base` (OpenID Connect Discovery 4) */
function wellKnownAppended(base: URL, name: string): string {
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return `${base.origin}${path}/.well-known/${name}`;
}

/** an error of the guarded client that is safe to show; anything else becomes `fallback` */
function safeRequestError(error: unknown, fallback: string): McpDiscoveryError {
  if (error instanceof McpDiscoveryError) return error;
  if (error instanceof CredentialDomainError || error instanceof SsrfBlockedError) {
    return new McpDiscoveryError(error.message);
  }
  return new McpDiscoveryError(fallback);
}

export class McpOAuthDiscovery {
  constructor(
    private readonly http: HttpClient,
    /** the credential's allowed domains (undefined = unrestricted) */
    private readonly allowedDomains: string[] | undefined,
  ) {}

  /** a JSON object from `url`, or undefined for a non-2xx answer or a body that is not a JSON object */
  private async getJson(url: string, what: string): Promise<Record<string, unknown> | undefined> {
    assertCredentialUrlAllowed(url, this.allowedDomains);
    let response: HttpFullResponse<unknown>;
    try {
      response = (await this.http.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json' },
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: DISCOVERY_TIMEOUT_MS,
        ...(this.allowedDomains === undefined ? {} : { allowedDomains: this.allowedDomains }),
      })) as HttpFullResponse<unknown>;
    } catch (error) {
      throw safeRequestError(error, `Couldn't read the ${what}`);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) return undefined;
    const body = response.body;
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  }

  /**
   * RFC 9728: the issuer of the authorization server that protects `resourceUrl`. A document that names
   * another resource is not used. Without any document the resource's origin is the issuer (the MCP
   * 2025-03-26 fallback).
   */
  async findIssuer(resourceUrl: string): Promise<{ issuer: string; scopesSupported: string[] }> {
    const resource = new URL(resourceUrl);
    const candidates: Array<{ url: string; identifiers: string[] }> = [
      { url: wellKnownInserted(resource, 'oauth-protected-resource'), identifiers: [resourceUrl] },
    ];
    if (resource.pathname !== '/') {
      candidates.push({
        url: `${resource.origin}/.well-known/oauth-protected-resource`,
        identifiers: [resourceUrl, resource.origin],
      });
    }
    for (const candidate of candidates) {
      const doc = await this.getJson(candidate.url, 'protected resource metadata');
      if (!doc) continue;
      if (
        typeof doc.resource === 'string' &&
        !candidate.identifiers.some((id) => sameUrl(id, doc.resource as string))
      ) {
        throw new McpDiscoveryError('The protected resource metadata is for another resource');
      }
      const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers : [];
      const first = servers.find((s): s is string => typeof s === 'string' && s.length > 0);
      if (!first)
        throw new McpDiscoveryError('The protected resource metadata names no authorization server');
      const scopes = Array.isArray(doc.scopes_supported)
        ? doc.scopes_supported.filter(
            (s): s is string => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s),
          )
        : [];
      return { issuer: requireSecureUrl(first, 'authorization server URL'), scopesSupported: scopes };
    }
    return { issuer: requireSecureUrl(resource.origin, 'authorization server URL'), scopesSupported: [] };
  }

  /** RFC 8414, then OpenID Connect discovery, for `issuer`; the document's issuer must be `issuer` */
  async authorizationServer(issuer: string): Promise<Omit<McpAuthorizationServer, 'scopesSupported'>> {
    const base = new URL(issuer);
    const urls = [
      wellKnownInserted(base, 'oauth-authorization-server'),
      wellKnownInserted(base, 'openid-configuration'),
    ];
    if (base.pathname !== '/') urls.push(wellKnownAppended(base, 'openid-configuration'));
    let doc: Record<string, unknown> | undefined;
    for (const url of urls) {
      doc = await this.getJson(url, 'authorization server metadata');
      if (doc) break;
    }
    if (!doc) throw new McpDiscoveryError("Couldn't find the authorization server metadata");
    if (typeof doc.issuer !== 'string' || !sameUrl(doc.issuer, issuer)) {
      throw new McpDiscoveryError('The authorization server metadata names another issuer');
    }
    const methods = Array.isArray(doc.code_challenge_methods_supported)
      ? doc.code_challenge_methods_supported
      : [];
    if (!methods.includes('S256')) {
      throw new McpDiscoveryError('The authorization server does not support PKCE with S256');
    }
    return {
      issuer,
      authorizationEndpoint: requireSecureUrl(doc.authorization_endpoint, 'authorization endpoint'),
      tokenEndpoint: requireSecureUrl(doc.token_endpoint, 'token endpoint'),
      registrationEndpoint:
        doc.registration_endpoint === undefined || doc.registration_endpoint === null
          ? undefined
          : requireSecureUrl(doc.registration_endpoint, 'registration endpoint'),
      clientIdMetadataDocumentSupported: doc.client_id_metadata_document_supported === true,
    };
  }

  /** the whole walk from the resource URL */
  async discover(resourceUrl: string): Promise<McpAuthorizationServer> {
    const resource = requireSecureUrl(resourceUrl, 'resource URL');
    const { issuer, scopesSupported } = await this.findIssuer(resource);
    return { ...(await this.authorizationServer(issuer)), scopesSupported };
  }

  /**
   * The client for `server`: our metadata document URL when the server states support and our base URL is
   * https (no registration call), else RFC 7591 registration of a public client with our callback URL.
   */
  async client(
    server: McpAuthorizationServer,
    ours: { baseUrl: string; callbackUrl: string; scope?: string },
  ): Promise<McpOAuthClient> {
    const metadataUrl = mcpClientMetadataUrl(ours.baseUrl);
    if (server.clientIdMetadataDocumentSupported && new URL(metadataUrl).protocol === 'https:') {
      return { clientId: metadataUrl, authentication: 'body', via: 'cimd' };
    }
    if (!server.registrationEndpoint) {
      throw new McpDiscoveryError(
        'The authorization server does not support automatic client registration. Turn off Register Client Automatically and enter a client ID.',
      );
    }
    assertCredentialUrlAllowed(server.registrationEndpoint, this.allowedDomains);
    let response: HttpFullResponse<unknown>;
    try {
      response = (await this.http.request({
        url: server.registrationEndpoint,
        method: 'POST',
        headers: { accept: 'application/json' },
        body: {
          client_name: MCP_CLIENT_NAME,
          redirect_uris: [ours.callbackUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...(ours.scope ? { scope: ours.scope } : {}),
        },
        bodyType: 'json',
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        // a registration answer is never followed to another URL
        followRedirects: false,
        timeout: DISCOVERY_TIMEOUT_MS,
        ...(this.allowedDomains === undefined ? {} : { allowedDomains: this.allowedDomains }),
      })) as HttpFullResponse<unknown>;
    } catch (error) {
      throw safeRequestError(error, "Couldn't register with the authorization server");
    }
    const body = (response.body && typeof response.body === 'object' ? response.body : {}) as Record<
      string,
      unknown
    >;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      // only the RFC 7591 error code, which is a fixed token, is shown; the description could quote anything
      const code =
        typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? `: ${body.error}` : '';
      throw new McpDiscoveryError(
        `Couldn't register with the authorization server (HTTP ${response.statusCode}${code})`,
      );
    }
    const clientId = clientValue(body.client_id, 'client ID');
    if (!clientId) throw new McpDiscoveryError('The registration answer did not contain a client ID');
    const clientSecret = clientValue(body.client_secret, 'client secret');
    return {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      authentication:
        clientSecret && body.token_endpoint_auth_method === 'client_secret_basic' ? 'header' : 'body',
      via: 'registration',
    };
  }
}

/**
 * A client id or secret from the server. It is stored on the credential, whose string values may be
 * expressions, so a value that reads as one (a leading `=`) is refused: it would be evaluated on read.
 */
function clientValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > MAX_CLIENT_ID_LENGTH ||
    value.startsWith('=') ||
    /[\r\n]/.test(value)
  ) {
    throw new McpDiscoveryError(`The registration answer has an invalid ${label}`);
  }
  return value;
}

/** our Client ID Metadata Document URL (the client id when the server supports CIMD) */
export function mcpClientMetadataUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${MCP_CLIENT_METADATA_PATH}`;
}

/** the Client ID Metadata Document served at `mcpClientMetadataUrl` (public, no secret) */
export function mcpClientMetadata(baseUrl: string, callbackUrl: string): Record<string, unknown> {
  return {
    client_id: mcpClientMetadataUrl(baseUrl),
    client_name: MCP_CLIENT_NAME,
    client_uri: baseUrl.replace(/\/$/, ''),
    redirect_uris: [callbackUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
