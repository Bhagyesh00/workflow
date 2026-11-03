/**
 * P2-10 allowed domains per credential, through the real engine and the real HttpClient: the credential
 * fields, the HTTP Request / GraphQL / pagination surfaces, redirects, an app node, OAuth2 token calls.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, requestOAuth2Token } from '@workflow/core';
import type { DataObject, NodeType } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { credentialTypes, nodeTypes, runNode } from './harness';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingMessage['headers'];
}

/** a server on one loopback address: 127.0.0.1 and 127.0.0.2 are different hosts to a credential */
async function serve(host: string, handler: (req: Seen, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers };
    seen.push(entry);
    handler(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const sendJson = (
  res: http.ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

type Server = Awaited<ReturnType<typeof serve>>;
let first: Server; // 127.0.0.1
let second: Server; // 127.0.0.2

// both loopback hosts pass the SSRF policy here; only the credential's list tells them apart
const services = () => ({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1', '127.0.0.2'] } }) });

/** a node of an app: it requests with its credential but not a URL the user typed (no credentialScope) */
const appNode: NodeType = {
  description: {
    name: 'l7.appNode',
    displayName: 'App node',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'App node' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'httpHeaderAuth', required: true }],
    properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
  },
  async execute(ctx) {
    const url = String(ctx.getNodeParameter('url', 0));
    const body = await ctx.helpers.httpRequestWithAuthentication('httpHeaderAuth', { url }, 0);
    return [[{ json: { body: body as never } }]];
  },
};

beforeAll(async () => {
  nodeTypes.register(appNode);
  second = await serve('127.0.0.2', (req, res) => {
    if (req.url === '/token') return sendJson(res, { access_token: 'tok-second', expires_in: 3600 });
    sendJson(res, { host: 'second' });
  });
  first = await serve('127.0.0.1', (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/redirect') {
      res.writeHead(302, { location: `${second.url}/landed` });
      return res.end();
    }
    if (path === '/redirect-within') {
      res.writeHead(302, { location: `${first.url}/landed` });
      return res.end();
    }
    if (path === '/page1') return sendJson(res, { items: [1], next: `${second.url}/page2` });
    if (path === '/graphql') return sendJson(res, { data: { ok: true } });
    if (path === '/token') return sendJson(res, { access_token: 'tok-first', expires_in: 3600 });
    sendJson(res, {
      host: 'first',
      auth: req.headers['x-api-key'] ?? null,
      bearer: req.headers.authorization ?? null,
    });
  });
});
afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
});
beforeEach(() => {
  first.seen.length = 0;
  second.seen.length = 0;
});

const KEY = { name: 'X-Api-Key', value: 'k-123' };
const restricted = (allowedDomains: string): DataObject => ({
  ...KEY,
  allowedHttpRequestDomains: 'domains',
  allowedDomains,
});

const request = (params: DataObject, creds: DataObject, type = 'core.httpRequest') =>
  runNode(
    type,
    { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...params },
    [{ json: {} }],
    { services: services(), creds: { httpHeaderAuth: creds } },
  );

describe('credential fields', () => {
  const fieldNames = (type: string) =>
    (credentialTypes.getResolved(type)?.properties ?? [])
      .map((p) => p.name)
      .filter((n) => /^allowed/.test(n));

  it.each([
    'httpBasicAuth',
    'httpHeaderAuth',
    'httpQueryAuth',
    'httpBearerAuth',
    'httpCustomAuth',
    'httpDigestAuth',
    'slackApi',
    'notionApi',
    'airtableTokenApi',
    'oAuth1Api',
    'oAuth2Api',
    'googleOAuth2Api',
    'gmailOAuth2',
    'googleSheetsOAuth2Api',
    'slackOAuth2Api',
  ])('%s gets the two fields, last', (type) => {
    expect(fieldNames(type)).toEqual(['allowedHttpRequestDomains', 'allowedDomains']);
    const names = credentialTypes.getResolved(type)!.properties.map((p) => p.name);
    expect(names.slice(-2)).toEqual(['allowedHttpRequestDomains', 'allowedDomains']);
  });

  it.each([
    'postgres',
    'redis',
    'mySql',
    'smtp',
    'telegramApi',
    'webhookSigningSecret',
    'jwtAuth',
    'totpApi',
    'ftp',
    'sftp',
    'sshPassword',
    'sshPrivateKey',
  ])('%s has no domain fields (it sends no HTTP requests with a credential)', (type) => {
    expect(fieldNames(type)).toEqual([]);
  });

  it('is idempotent: resolving again, or resolving a child of a type that has them, never doubles them', () => {
    const before = credentialTypes.getResolved('gmailOAuth2')!.properties.length;
    expect(credentialTypes.getResolved('gmailOAuth2')!.properties).toHaveLength(before);
    const own = credentialTypes.get('gmailOAuth2')!.properties.map((p) => p.name);
    expect(own).not.toContain('allowedDomains');
    const names = credentialTypes.getResolved('gmailOAuth2')!.properties.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('are not added when the type sets hideDomainRestrictionFields, nor to its children', async () => {
    const { CredentialTypes } = await import('@workflow/core');
    const registry = new CredentialTypes([
      {
        name: 'hiddenApi',
        displayName: 'Hidden',
        properties: [{ displayName: 'Key', name: 'key', type: 'string', default: '' }],
        authenticate: { type: 'generic', properties: { headers: { 'x-key': '={{$credentials.key}}' } } },
        hideDomainRestrictionFields: true,
      },
      { name: 'childApi', displayName: 'Child', extends: ['hiddenApi'], properties: [] },
      {
        name: 'shownApi',
        displayName: 'Shown',
        properties: [{ displayName: 'Key', name: 'key', type: 'string', default: '' }],
        authenticate: { type: 'generic', properties: { headers: { 'x-key': '={{$credentials.key}}' } } },
      },
    ]);
    const names = (type: string) => registry.getResolved(type)!.properties.map((p) => p.name);
    expect(names('hiddenApi')).toEqual(['key']);
    expect(names('childApi')).toEqual(['key']);
    expect(names('shownApi')).toEqual(['key', 'allowedHttpRequestDomains', 'allowedDomains']);
  });

  it('the list field only shows for "Specific Domains"', () => {
    const list = credentialTypes
      .getResolved('httpHeaderAuth')!
      .properties.find((p) => p.name === 'allowedDomains')!;
    expect(list.displayOptions).toEqual({ show: { allowedHttpRequestDomains: ['domains'] } });
  });
});

describe('HTTP Request', () => {
  it('refuses a request to another domain with zero requests at that server', async () => {
    const r = await request({ url: `${first.url}/data` }, restricted('example.com, *.example.org'));
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('Domain not allowed');
    expect(String(r.error?.message)).toContain('127.0.0.1');
    expect(first.seen).toHaveLength(0);
  });

  it('sends the request to a listed domain, with the credential', async () => {
    const r = await request({ url: `${first.url}/data` }, restricted('example.com, 127.0.0.1'));
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ host: 'first', auth: 'k-123', bearer: null }]);
  });

  it('"all" (and a credential saved before the fields existed) changes nothing', async () => {
    for (const creds of [{ ...KEY, allowedHttpRequestDomains: 'all' }, KEY]) {
      const r = await request({ url: `${first.url}/data` }, creds);
      expect(r.status).toBe('success');
      expect(r.outputs[0][0].auth).toBe('k-123');
    }
    // a redirect to another host is followed as before
    const redirected = await request({ url: `${first.url}/redirect` }, KEY);
    expect(redirected.outputs[0]).toEqual([{ host: 'second' }]);
  });

  it('"none" refuses the credential in the HTTP Request node', async () => {
    const r = await request({ url: `${first.url}/data` }, { ...KEY, allowedHttpRequestDomains: 'none' });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('prevent use within an HTTP Request or GraphQL node');
    expect(first.seen).toHaveLength(0);
  });

  it('"Specific Domains" with an empty list is an error, not "allow all"', async () => {
    const r = await request({ url: `${first.url}/data` }, restricted(' '));
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('No allowed domains specified');
    expect(first.seen).toHaveLength(0);
  });

  it('refuses a redirect to another domain: the second server sees nothing', async () => {
    const r = await request({ url: `${first.url}/redirect` }, restricted('127.0.0.1'));
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('Domain not allowed');
    expect(String(r.error?.message)).toContain('127.0.0.2');
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(0);
  });

  it('follows a redirect that stays inside the list, and one to a second listed domain', async () => {
    const within = await request({ url: `${first.url}/redirect-within` }, restricted('127.0.0.1'));
    expect(within.status).toBe('success');
    const across = await request({ url: `${first.url}/redirect` }, restricted('127.0.0.1, 127.0.0.2'));
    expect(across.outputs[0]).toEqual([{ host: 'second' }]);
    expect(second.seen).toHaveLength(1);
    // the credential header is not an Authorization header, so it travels to the listed host
    expect(second.seen[0].headers['x-api-key']).toBe('k-123');
  });

  it('checks the next URL of pagination', async () => {
    const pagination = {
      paginationMode: 'responseContainsNextURL',
      nextURL: '={{ $response.body.next }}',
      paginationCompleteWhen: 'responseIsEmpty',
    };
    const blocked = await request(
      { url: `${first.url}/page1`, options: { pagination: { pagination } } },
      restricted('127.0.0.1'),
    );
    expect(blocked.status).toBe('error');
    expect(String(blocked.error?.message)).toContain('Domain not allowed');
    expect(second.seen).toHaveLength(0);

    const allowed = await request(
      { url: `${first.url}/page1`, options: { pagination: { pagination } } },
      restricted('127.0.0.1, 127.0.0.2'),
    );
    expect(allowed.status).toBe('success');
    expect(second.seen).toHaveLength(1);
  });

  it('works with basic auth too: a blocked request is refused before the credential is applied', async () => {
    const r = await runNode(
      'core.httpRequest',
      { url: `${first.url}/data`, authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' },
      [{ json: {} }],
      {
        services: services(),
        creds: {
          httpBasicAuth: {
            user: 'u',
            password: 'p',
            allowedHttpRequestDomains: 'domains',
            allowedDomains: 'x.test',
          },
        },
      },
    );
    expect(r.status).toBe('error');
    expect(first.seen).toHaveLength(0);
  });
});

describe('GraphQL', () => {
  const graphql = (endpoint: string, creds: DataObject) =>
    request({ endpoint, query: '{ ok }' }, creds, 'core.graphql');

  it('refuses another domain with zero requests, and sends to a listed one', async () => {
    const blocked = await graphql(`${first.url}/graphql`, restricted('example.com'));
    expect(blocked.status).toBe('error');
    expect(String(blocked.error?.message)).toContain('Domain not allowed');
    expect(first.seen).toHaveLength(0);

    const allowed = await graphql(`${first.url}/graphql`, restricted('127.0.0.1'));
    expect(allowed.status).toBe('success');
    expect(first.seen).toHaveLength(1);
  });

  it('"none" refuses the credential in the GraphQL node', async () => {
    const r = await graphql(`${first.url}/graphql`, { ...KEY, allowedHttpRequestDomains: 'none' });
    expect(r.status).toBe('error');
    expect(first.seen).toHaveLength(0);
  });
});

describe('an app node (a URL the user did not type)', () => {
  const app = (creds: DataObject, url = `${first.url}/data`) =>
    runNode('l7.appNode', { url }, [{ json: {} }], {
      services: services(),
      creds: { httpHeaderAuth: creds },
    });

  it('is not blocked by "none"', async () => {
    const r = await app({ ...KEY, allowedHttpRequestDomains: 'none' });
    expect(r.status).toBe('success');
    expect(first.seen).toHaveLength(1);
  });

  it('is held to a list of domains', async () => {
    const blocked = await app(restricted('example.com'));
    expect(blocked.status).toBe('error');
    expect(first.seen).toHaveLength(0);
    const allowed = await app(restricted('127.0.0.1'));
    expect(allowed.status).toBe('success');
  });
});

describe('OAuth2 token calls', () => {
  const oauth = (accessTokenUrl: string, list: string, extra: DataObject = {}) =>
    runNode(
      'core.httpRequest',
      { url: `${first.url}/data`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
      [{ json: {} }],
      {
        services: services(),
        creds: {
          oAuth2Api: {
            grantType: 'clientCredentials',
            accessTokenUrl,
            clientId: 'id',
            clientSecret: 'secret',
            allowedHttpRequestDomains: 'domains',
            allowedDomains: list,
            ...extra,
          },
        },
      },
    );

  it('refuses a token URL outside the list: no request reaches the token server or the API', async () => {
    const r = await oauth(`${second.url}/token`, '127.0.0.1');
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('Domain not allowed');
    expect(second.seen).toHaveLength(0);
    expect(first.seen).toHaveLength(0);
  });

  it('sends the token call and the API call when both hosts are listed', async () => {
    const r = await oauth(`${second.url}/token`, '127.0.0.1, 127.0.0.2');
    expect(r.status).toBe('success');
    expect(second.seen.map((s) => s.url)).toEqual(['/token']);
    expect(r.outputs[0][0].bearer).toBe('Bearer tok-second');
  });

  it('a token call that redirects to an unlisted host is refused on the hop', async () => {
    // /token-redirect on the first server sends the token call to the second server
    const redirecting = await serve('127.0.0.1', (_req, res) => {
      res.writeHead(307, { location: `${second.url}/token` });
      res.end();
    });
    try {
      const r = await oauth(`${redirecting.url}/token`, '127.0.0.1');
      expect(r.status).toBe('error');
      expect(String(r.error?.message)).toContain('Domain not allowed');
      expect(second.seen).toHaveLength(0);
    } finally {
      await redirecting.close();
    }
  });

  it('"none" does not stop the credential own token call (the token URL is not typed by a user)', async () => {
    const client = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
    try {
      const token = await requestOAuth2Token(
        client,
        {
          accessTokenUrl: `${first.url}/token`,
          clientId: 'id',
          clientSecret: 'secret',
          allowedHttpRequestDomains: 'none',
        },
        { type: 'client_credentials' },
      );
      expect(token.access_token).toBe('tok-first');
    } finally {
      await client.close();
    }
  });
});
