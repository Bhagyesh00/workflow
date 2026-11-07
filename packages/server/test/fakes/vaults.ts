/**
 * In-process fakes of the six vaults (P4-08 tests), each on node:http. A fake checks what the real
 * service checks (the SigV4 signature, the RS256 assertion, the bearer token) and answers 401 or 403
 * otherwise, so a provider that signs wrongly fails here. `rewriteHttp` sends the fixed cloud hosts to a
 * fake and keeps the URL each provider asked for, so a test can assert the host.
 */
import { createVerify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type HttpClient, signAwsRequest } from '@workflow/core';

export interface Recorded {
  method: string;
  /** path and query */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface Fake {
  origin: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export type Handler = (req: Recorded, res: ServerResponse) => void;

export function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export async function startFake(handler: Handler): Promise<Fake> {
  const requests: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const recorded: Recorded = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A client that sends the URLs of the listed hosts to a fake and passes the rest on. `asked` keeps the
 * URL every provider call was made with, before the rewrite.
 */
export function rewriteHttp(
  real: HttpClient,
  routes: Record<string, string>,
): { http: HttpClient; asked: string[] } {
  const asked: string[] = [];
  const http = {
    request: (options: { url: string }, signal?: AbortSignal) => {
      asked.push(options.url);
      const url = new URL(options.url);
      const target = routes[url.host];
      const rewritten = target ? `${target}${url.pathname}${url.search}` : options.url;
      return real.request({ ...options, url: rewritten } as never, signal);
    },
  } as unknown as HttpClient;
  return { http, asked };
}

// -------------------------------------------------------------------------------------------- AWS

export interface AwsFakeOptions {
  /** the host the provider must have signed for */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  secrets: Record<string, string | { binary: true }>;
  /** names per ListSecrets page; default 100 */
  pageSize?: number;
}

export function awsHandler(opts: AwsFakeOptions): Handler {
  const names = Object.keys(opts.secrets);
  return (req, res) => {
    const stamp = String(req.headers['x-amz-date'] ?? '');
    const date = new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    );
    const expected = signAwsRequest({
      method: req.method,
      url: `https://${opts.host}${req.path}`,
      headers: {
        'content-type': String(req.headers['content-type'] ?? ''),
        'x-amz-target': String(req.headers['x-amz-target'] ?? ''),
      },
      body: req.body,
      region: opts.region,
      service: 'secretsmanager',
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      date,
    });
    if (req.headers.authorization !== expected.headers.authorization) {
      return reply(res, 403, { __type: 'InvalidSignatureException', message: 'SECRET-BODY-aws' });
    }
    const payload = JSON.parse(req.body || '{}') as Record<string, unknown>;
    const target = String(req.headers['x-amz-target']);
    if (target === 'secretsmanager.ListSecrets') {
      const size = Math.min(Number(payload.MaxResults ?? 100), opts.pageSize ?? 100);
      const from = payload.NextToken ? Number(payload.NextToken) : 0;
      const page = names.slice(from, from + size);
      return reply(res, 200, {
        SecretList: page.map((Name) => ({ Name })),
        ...(from + size < names.length ? { NextToken: String(from + size) } : {}),
      });
    }
    if (target === 'secretsmanager.BatchGetSecretValue') {
      const ids = payload.SecretIdList as string[];
      return reply(res, 200, {
        SecretValues: ids.map((Name) => {
          const value = opts.secrets[Name];
          return typeof value === 'string' ? { Name, SecretString: value } : { Name, SecretBinary: 'AAEC' };
        }),
      });
    }
    return reply(res, 400, {});
  };
}

// -------------------------------------------------------------------------------------------- GCP

export interface GcpFakeOptions {
  projectId: string;
  email: string;
  publicKey: KeyObject;
  /** a number is the status the access call answers with */
  secrets: Record<string, string | number>;
  pageSize?: number;
}

export function gcpHandler(opts: GcpFakeOptions): Handler {
  const token = 'gcp-access-token';
  const names = Object.keys(opts.secrets);
  return (req, res) => {
    if (req.path === '/token') {
      const form = new URLSearchParams(req.body);
      const [head, claims, signature] = String(form.get('assertion')).split('.');
      const verify = createVerify('RSA-SHA256').update(`${head}.${claims}`);
      const claim = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const good =
        form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
        verify.verify(opts.publicKey, Buffer.from(signature ?? '', 'base64url')) &&
        claim.iss === opts.email &&
        claim.aud === 'https://oauth2.googleapis.com/token';
      return good
        ? reply(res, 200, { access_token: token, expires_in: 3600 })
        : reply(res, 401, 'SECRET-BODY-gcp');
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, {});
    const base = `/v1/projects/${opts.projectId}/secrets`;
    if (req.path === base) {
      const size = Math.min(Number(req.query.get('pageSize') ?? 250), opts.pageSize ?? 250);
      const from = Number(req.query.get('pageToken') ?? 0);
      const page = names.slice(from, from + size);
      return reply(res, 200, {
        secrets: page.map((n) => ({ name: `projects/123456/secrets/${n}` })),
        ...(from + size < names.length ? { nextPageToken: String(from + size) } : {}),
      });
    }
    const match = new RegExp(`^${base}/([^/]+)/versions/latest:access$`).exec(req.path);
    const value = match ? opts.secrets[match[1]] : undefined;
    if (typeof value === 'string') {
      return reply(res, 200, { payload: { data: Buffer.from(value).toString('base64') } });
    }
    return reply(res, typeof value === 'number' ? value : 404, 'SECRET-BODY-gcp');
  };
}

// ------------------------------------------------------------------------------------------- Azure

export interface AzureFakeOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** the scope the token request must ask for */
  scope: string;
  secrets: Record<string, { value?: string; enabled?: boolean; status?: number }>;
  pageSize?: number;
}

export function azureHandler(opts: AzureFakeOptions): Handler {
  const token = 'azure-access-token';
  const names = Object.keys(opts.secrets);
  return (req, res) => {
    if (req.path === `/${opts.tenantId}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(req.body);
      const good =
        form.get('grant_type') === 'client_credentials' &&
        form.get('client_id') === opts.clientId &&
        form.get('client_secret') === opts.clientSecret &&
        form.get('scope') === opts.scope;
      return good
        ? reply(res, 200, { access_token: token, expires_in: 3600 })
        : reply(res, 401, 'SECRET-BODY-azure');
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, {});
    if (req.query.get('api-version') !== '7.4') return reply(res, 400, {});
    if (req.path === '/secrets') {
      const size = opts.pageSize ?? 25;
      const from = Number(req.query.get('$skiptoken') ?? 0);
      const page = names.slice(from, from + size);
      return reply(res, 200, {
        value: page.map((n) => ({
          id: `https://vault.example.invalid/secrets/${n}`,
          attributes: { enabled: opts.secrets[n].enabled !== false },
        })),
        // a link to another host: the provider must ask the same vault, by path
        ...(from + size < names.length
          ? {
              nextLink: `https://elsewhere.example.invalid/secrets?api-version=7.4&$skiptoken=${from + size}`,
            }
          : {}),
      });
    }
    const name = /^\/secrets\/([^/]+)$/.exec(req.path)?.[1];
    const entry = name ? opts.secrets[name] : undefined;
    if (entry?.value !== undefined) return reply(res, 200, { value: entry.value });
    return reply(res, entry?.status ?? 404, 'SECRET-BODY-azure');
  };
}

// ------------------------------------------------------------------------------------------ Vault

export interface VaultMountFake {
  version: 1 | 2;
  /** path under the mount -> key/value object */
  secrets: Record<string, Record<string, string>>;
}

export interface VaultFakeOptions {
  /** a token the fake accepts without a login */
  token?: string;
  username?: string;
  password?: string;
  roleId?: string;
  secretId?: string;
  namespace?: string;
  /** lease of a login token and of the static token, in seconds */
  ttl?: number;
  mounts: Record<string, VaultMountFake>;
  /** sys/mounts answers 403 */
  denyMounts?: boolean;
}

export function vaultHandler(
  opts: VaultFakeOptions,
): Handler & { renewals: () => number; logins: () => number } {
  let renewals = 0;
  let logins = 0;
  const issued = new Set<string>(opts.token ? [opts.token] : []);
  const ttl = opts.ttl ?? 0;
  const handler: Handler = (req, res) => {
    if (!req.path.startsWith('/v1/')) return reply(res, 404, {});
    if (opts.namespace && req.headers['x-vault-namespace'] !== opts.namespace) return reply(res, 403, {});
    const path = req.path.slice('/v1/'.length);
    const login = (): void => {
      logins += 1;
      const clientToken = `s.${issued.size}-${logins}`;
      issued.add(clientToken);
      reply(res, 200, { auth: { client_token: clientToken, lease_duration: ttl, renewable: true } });
    };
    const body = req.body ? (JSON.parse(req.body) as Record<string, string>) : {};
    if (path === `auth/userpass/login/${encodeURIComponent(opts.username ?? '')}`) {
      return body.password === opts.password ? login() : reply(res, 400, {});
    }
    if (path === 'auth/approle/login') {
      return body.role_id === opts.roleId && body.secret_id === opts.secretId ? login() : reply(res, 400, {});
    }
    if (!issued.has(String(req.headers['x-vault-token']))) return reply(res, 403, {});
    if (path === 'auth/token/lookup-self') return reply(res, 200, { data: { ttl, renewable: true } });
    if (path === 'auth/token/renew-self') {
      renewals += 1;
      return reply(res, 200, { auth: { lease_duration: ttl, renewable: true } });
    }
    if (path === 'sys/mounts') {
      if (opts.denyMounts) return reply(res, 403, {});
      const data: Record<string, unknown> = {
        'sys/': { type: 'system' },
        'cubbyhole/': { type: 'cubbyhole' },
      };
      for (const [name, mount] of Object.entries(opts.mounts)) {
        data[`${name}/`] = { type: 'kv', options: mount.version === 2 ? { version: '2' } : {} };
      }
      return reply(res, 200, { data });
    }
    const [mountName, ...rest] = path.split('/');
    const mount = opts.mounts[mountName];
    if (!mount) return reply(res, 404, {});
    const tail = rest.join('/');
    if (req.query.get('list') === 'true') {
      const folder = (mount.version === 2 ? tail.replace(/^metadata\/?/, '') : tail).replace(/\/+$/, '');
      const prefix = folder ? `${folder}/` : '';
      const keys = new Set<string>();
      for (const key of Object.keys(mount.secrets)) {
        if (!key.startsWith(prefix)) continue;
        const [first, ...more] = key.slice(prefix.length).split('/');
        keys.add(more.length ? `${first}/` : first);
      }
      return keys.size ? reply(res, 200, { data: { keys: [...keys] } }) : reply(res, 404, { errors: [] });
    }
    const secretPath = mount.version === 2 ? tail.replace(/^data\//, '') : tail;
    const value = mount.secrets[secretPath];
    if (!value) return reply(res, 404, {});
    return reply(res, 200, mount.version === 2 ? { data: { data: value, metadata: {} } } : { data: value });
  };
  return Object.assign(handler, { renewals: () => renewals, logins: () => logins });
}

// ------------------------------------------------------------------------------------ 1Password

export interface OnePasswordFakeOptions {
  token: string;
  /** vault id -> item id -> item */
  vaults: Record<
    string,
    Record<string, { title: string; fields: Array<{ label?: string; value?: string }> }>
  >;
}

export function onePasswordHandler(opts: OnePasswordFakeOptions): Handler {
  return (req, res) => {
    if (req.headers.authorization !== `Bearer ${opts.token}`) return reply(res, 401, {});
    const parts = req.path.split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'vaults') return reply(res, 404, {});
    if (parts.length === 2)
      return reply(
        res,
        200,
        Object.keys(opts.vaults).map((id) => ({ id, name: id })),
      );
    const vault = opts.vaults[parts[2]];
    if (!vault) return reply(res, 404, {});
    if (parts.length === 4 && parts[3] === 'items') {
      return reply(
        res,
        200,
        Object.entries(vault).map(([id, item]) => ({ id, title: item.title })),
      );
    }
    const item = parts.length === 5 ? vault[parts[4]] : undefined;
    return item
      ? reply(res, 200, { id: parts[4], title: item.title, fields: item.fields })
      : reply(res, 404, {});
  };
}

// ----------------------------------------------------------------------------------- Infisical

export interface InfisicalFakeOptions {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
  secrets: Record<string, string>;
  /** imported secrets; a key of `secrets` wins */
  imports?: Record<string, string>;
  /** seconds the access token lives */
  expiresIn?: number;
}

export function infisicalHandler(opts: InfisicalFakeOptions): Handler {
  let issued = 0;
  return (req, res) => {
    if (req.path === '/api/v1/auth/universal-auth/login') {
      const body = JSON.parse(req.body || '{}') as Record<string, string>;
      if (body.clientId !== opts.clientId || body.clientSecret !== opts.clientSecret) {
        return reply(res, 401, 'SECRET-BODY-infisical');
      }
      issued += 1;
      return reply(res, 200, {
        accessToken: `inf-token-${issued}`,
        expiresIn: opts.expiresIn ?? 7200,
        tokenType: 'Bearer',
      });
    }
    if (req.path === '/api/v4/secrets') {
      if (!String(req.headers.authorization).startsWith('Bearer inf-token-')) return reply(res, 401, {});
      const good =
        req.query.get('projectId') === opts.projectId &&
        req.query.get('environment') === opts.environment &&
        req.query.get('secretPath') === opts.secretPath;
      if (!good) return reply(res, 404, {});
      const toList = (map: Record<string, string>) =>
        Object.entries(map).map(([secretKey, secretValue]) => ({ secretKey, secretValue }));
      return reply(res, 200, {
        secrets: toList(opts.secrets),
        imports: [{ secretPath: '/shared', secrets: toList(opts.imports ?? {}) }],
      });
    }
    return reply(res, 404, {});
  };
}
