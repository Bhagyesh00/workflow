/**
 * P6-10 (L8): an OpenID Connect provider on `node:http` for tests (127.0.0.1, an ephemeral port): discovery,
 * authorization-code token endpoint, JWKS, userinfo and an end session endpoint. ID tokens are RS256, signed
 * with node crypto. No real provider, no network beyond 127.0.0.1. Other lanes (SAML provisioning, OIDC
 * provisioning) drive it the same way: `authorize(authUrl, who)` plays the browser's visit to the provider
 * and returns the query the provider sends back to the callback.
 */
import { createPrivateKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOidcPerson {
  sub: string;
  email?: string;
  /** omitted from the token when `undefined`; pass `false` or `true` to send it */
  email_verified?: boolean | string;
  given_name?: string;
  family_name?: string;
  name?: string;
  /** extra claims (groups, roles) */
  extra?: Record<string, unknown>;
}

/** what one authorization visit changes in the tokens the provider hands out */
export interface FakeOidcVisit {
  person: FakeOidcPerson;
  /** replaces a claim of the id token (iss, aud, nonce, exp, iat) */
  idToken?: Record<string, unknown>;
  /** claims only the userinfo answer holds */
  userinfo?: Record<string, unknown>;
  /** the id token signed with another key (a key the JWKS does not list) */
  signWithOtherKey?: boolean;
  /** the provider answers the callback with an error instead of a code */
  error?: { error: string; description?: string };
  /** the state the browser gets back (default: the one sent) */
  state?: string;
}

export interface FakeOidcRequest {
  method: string;
  path: string;
  body: string;
  authorization?: string;
}

export interface FakeOidcOptions {
  clientId?: string;
  clientSecret?: string;
  /** merged into the discovery document (for example a `userinfo_endpoint` on 10.0.0.5) */
  metadata?: Record<string, unknown>;
  /** the discovery answers 302 to this Location */
  discoveryRedirect?: string;
  /** no `end_session_endpoint` in the discovery */
  noEndSession?: boolean;
  /** no `userinfo_endpoint` in the discovery */
  noUserinfo?: boolean;
}

export interface FakeOidcIdp {
  /** `http://127.0.0.1:<port>` */
  url: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  endSessionUrl: string;
  /** every request the provider got, oldest first */
  requests: FakeOidcRequest[];
  /** the form bodies of the token endpoint, parsed */
  tokenRequests: Array<Record<string, string>>;
  /** the id token of the last token answer */
  lastIdToken?: string;
  /** the end session requests' query strings */
  endSessionQueries: string[];
  /** plays the browser at the provider: the query to send to the callback (code and state, or the error) */
  authorize(authorizationUrl: string, visit: FakeOidcVisit): Record<string, string>;
  /** merges into the discovery document from now on */
  setMetadata(patch: Record<string, unknown>): void;
  close(): Promise<void>;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${b64url(signer.sign(key))}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function startFakeOidcIdp(options: FakeOidcOptions = {}): Promise<FakeOidcIdp> {
  const clientId = options.clientId ?? `client-${randomBytes(4).toString('hex')}`;
  const clientSecret = options.clientSecret ?? randomBytes(16).toString('hex');
  const kid = `kid-${randomBytes(3).toString('hex')}`;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = createPrivateKey(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  let metadataPatch: Record<string, unknown> = { ...(options.metadata ?? {}) };

  /** codes handed out by `authorize`, each used once */
  const codes = new Map<string, FakeOidcVisit & { nonce: string; redirectUri: string; accessToken: string }>();
  const accessTokens = new Map<string, FakeOidcVisit>();
  const requests: FakeOidcRequest[] = [];
  const tokenRequests: Array<Record<string, string>> = [];
  const endSessionQueries: string[] = [];
  let baseUrl = '';
  const idp = {} as FakeOidcIdp;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1');
      const body = await readBody(request);
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        body,
        authorization: request.headers.authorization,
      });
      if (url.pathname === '/.well-known/openid-configuration') {
        if (options.discoveryRedirect) {
          response.writeHead(302, { location: options.discoveryRedirect });
          response.end();
          return;
        }
        const document: Record<string, unknown> = {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          ...(options.noUserinfo ? {} : { userinfo_endpoint: `${baseUrl}/userinfo` }),
          ...(options.noEndSession ? {} : { end_session_endpoint: `${baseUrl}/logout` }),
          ...metadataPatch,
        };
        json(response, 200, document);
        return;
      }
      if (url.pathname === '/jwks') {
        json(response, 200, { keys: [jwk] });
        return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
        tokenRequests.push(form);
        const basic = request.headers.authorization?.startsWith('Basic ')
          ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString()
          : null;
        const secretOk = form.client_secret === idp.clientSecret || basic === `${clientId}:${idp.clientSecret}`;
        const issued = form.code ? codes.get(form.code) : undefined;
        if (!secretOk || form.grant_type !== 'authorization_code' || !issued) {
          json(response, 400, { error: 'invalid_grant', error_description: 'IDP-SECRET-TEXT' });
          return;
        }
        codes.delete(form.code);
        const now = Math.floor(Date.now() / 1000);
        const person = issued.person;
        const claims: Record<string, unknown> = {
          iss: baseUrl,
          aud: clientId,
          sub: person.sub,
          iat: now,
          exp: now + 300,
          nonce: issued.nonce,
          ...(person.email === undefined ? {} : { email: person.email }),
          ...(person.email_verified === undefined ? {} : { email_verified: person.email_verified }),
          ...(person.given_name ? { given_name: person.given_name } : {}),
          ...(person.family_name ? { family_name: person.family_name } : {}),
          ...(person.name ? { name: person.name } : {}),
          ...(person.extra ?? {}),
          ...(issued.idToken ?? {}),
        };
        const idToken = signJwt(
          claims,
          issued.signWithOtherKey
            ? createPrivateKey(other.privateKey.export({ type: 'pkcs8', format: 'pem' }))
            : privateKey,
          kid,
        );
        idp.lastIdToken = idToken;
        accessTokens.set(issued.accessToken, issued);
        json(response, 200, {
          access_token: issued.accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
        return;
      }
      if (url.pathname === '/userinfo') {
        const token = (request.headers.authorization ?? '').replace(/^Bearer /i, '');
        const visit = accessTokens.get(token);
        if (!visit) {
          json(response, 401, { error: 'invalid_token' });
          return;
        }
        json(response, 200, {
          sub: visit.person.sub,
          ...(visit.person.email === undefined ? {} : { email: visit.person.email }),
          ...(visit.userinfo ?? {}),
        });
        return;
      }
      if (url.pathname === '/logout') {
        endSessionQueries.push(url.search);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('signed out');
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  Object.assign(idp, {
    url: baseUrl,
    issuer: baseUrl,
    discoveryUrl: `${baseUrl}/.well-known/openid-configuration`,
    clientId,
    clientSecret,
    endSessionUrl: `${baseUrl}/logout`,
    requests,
    tokenRequests,
    endSessionQueries,
    authorize(authorizationUrl: string, visit: FakeOidcVisit): Record<string, string> {
      const params = new URL(authorizationUrl).searchParams;
      const state = visit.state ?? params.get('state') ?? '';
      if (visit.error) return { error: visit.error.error, ...(visit.error.description ? { error_description: visit.error.description } : {}), state };
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.set(code, {
        ...visit,
        nonce: params.get('nonce') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        accessToken: `at-${randomBytes(8).toString('hex')}`,
      });
      return { code, state };
    },
    setMetadata(patch: Record<string, unknown>): void {
      metadataPatch = { ...metadataPatch, ...patch };
    },
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  });
  return idp;
}
