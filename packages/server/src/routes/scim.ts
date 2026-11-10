/**
 * SCIM 2.0 (P6-02, L13), under `/scim/v2` outside the `/rest` session and CSRF hook: the identity
 * provider's SCIM client calls it with the workspace's SCIM token (`Authorization: Bearer`), and the token
 * alone names the workspace. GET and POST `/Users`, GET, PUT, PATCH and DELETE `/Users/:id`, GET
 * `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`. Bodies are `application/scim+json` (own parser,
 * 1 MB).
 * Every call checks the token first (401), then that SCIM is on (403) and that SSO is on (403); errors are
 * answered in the SCIM error shape. `SCIM_RATE_LIMIT` calls per IP per 5 minutes across all SCIM routes
 * (0 = off).
 */
import { redactSecrets } from '@workflow/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import type { TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { SCIM_ERROR_SCHEMA, ScimError, type ScimReply, scimSettingsOf } from '../services/scim';
import { tenantOfScimToken } from '../services/scim-token';

const SCIM_BODY_LIMIT = 1_048_576;
const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';
const RATE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_COUNT = 100;

/** a SCIM body; `__proto__` keys are dropped, as the JSON parser of the app does */
function parseScimJson(_request: unknown, body: string, done: (err: Error | null, value?: unknown) => void) {
  if (!body?.trim()) return done(null, undefined);
  try {
    done(
      null,
      JSON.parse(body, (key, value) => (key === '__proto__' ? undefined : value)),
    );
  } catch {
    const error = new Error('The request body is not valid JSON') as Error & { statusCode: number };
    error.statusCode = 400;
    done(error);
  }
}

/** the bearer token of a request; the scheme is case-insensitive */
function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^bearer\s+(\S+)\s*$/i.exec(header)?.[1];
}

/** a query number: absent is the default, anything but digits is a 400 */
function intParam(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^-?\d{1,9}$/.test(value)) {
    throw new ScimError(400, `${name} must be a number`, 'invalidValue');
  }
  return Number(value);
}

export async function scimPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  app.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string', bodyLimit: SCIM_BODY_LIMIT },
    parseScimJson,
  );

  // every error of this plugin is a SCIM error: schemas, status as a string, detail, scimType
  app.setErrorHandler((error, request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    let status = 500;
    let detail = 'Internal server error';
    let scimType: string | undefined;
    if (e instanceof ScimError) {
      status = e.statusCode;
      detail = redactSecrets(e.message);
      scimType = e.scimType;
    } else if (e instanceof ApiError) {
      status = e.statusCode;
      detail = redactSecrets(e.message);
      if (status === 409) scimType = 'uniqueness';
    } else if (e.statusCode === 429) {
      status = 429;
      detail = 'Too many requests, please try again later';
    } else if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      status = 413;
      detail = 'The request body is too large';
    } else if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      status = e.statusCode;
      detail = status === 400 ? 'The request body is not valid' : 'The request was refused';
      if (status === 400) scimType = 'invalidSyntax';
    } else {
      request.log.error({ err: error }, 'SCIM request failed');
    }
    return reply
      .status(status)
      .type(SCIM_CONTENT_TYPE)
      .send({
        schemas: [SCIM_ERROR_SCHEMA],
        status: String(status),
        detail,
        ...(scimType ? { scimType } : {}),
      });
  });

  /** the workspace of the request, from the token alone; 401 and 403 with n8n's texts */
  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<TenantRow> {
    const token = bearerOf(request);
    if (!token) {
      reply.header('www-authenticate', 'Bearer');
      throw new ScimError(401, 'Authorization header with Bearer token required');
    }
    const tenant = await tenantOfScimToken(ctx.scim.deps, token);
    if (!tenant) {
      reply.header('www-authenticate', 'Bearer');
      throw new ScimError(401, 'Invalid SCIM API key');
    }
    if (!scimSettingsOf(tenant).enabled) throw new ScimError(403, 'SCIM provisioning is disabled');
    if (!(await ctx.ssoSettings.isSsoActive(tenant.id))) {
      throw new ScimError(403, 'SCIM provisioning requires SAML or OIDC single sign-on');
    }
    return tenant;
  }

  const rateLimit =
    ctx.config.scimRateLimit > 0
      ? {
          max: ctx.config.scimRateLimit,
          timeWindow: RATE_WINDOW_MS,
          keyGenerator: (request: FastifyRequest) => `scim:${request.ip}`,
        }
      : false;
  // one budget per IP across every SCIM route (a route's own config.rateLimit gets its own store)
  if (rateLimit) app.addHook('onRequest', app.rateLimit(rateLimit));
  const route = {};

  const send = (reply: FastifyReply, result: ScimReply) => {
    reply.status(result.status).type(SCIM_CONTENT_TYPE);
    return result.status === 204 ? reply.send() : reply.send(result.body);
  };
  const objectBody = (request: FastifyRequest): Record<string, never> => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ScimError(400, 'The request body must be a JSON object', 'invalidSyntax');
    }
    return body as Record<string, never>;
  };
  const idOf = (request: FastifyRequest): string => String((request.params as { id?: string }).id ?? '');

  // the SCIM token is the proof: no session, no CSRF
  app.get('/Users', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    const query = request.query as Record<string, unknown>;
    return send(
      reply,
      await ctx.scim.listUsers(tenant, {
        filter: typeof query.filter === 'string' ? query.filter : undefined,
        startIndex: intParam(query.startIndex, 1, 'startIndex'),
        count: intParam(query.count, DEFAULT_COUNT, 'count'),
      }),
    );
  });
  app.post('/Users', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    return send(reply, await ctx.scim.createUser(tenant, objectBody(request)));
  });
  app.get('/Users/:id', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    return send(reply, await ctx.scim.getUser(tenant, idOf(request)));
  });
  app.put('/Users/:id', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    return send(reply, await ctx.scim.replaceUser(tenant, idOf(request), objectBody(request)));
  });
  app.patch('/Users/:id', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    return send(reply, await ctx.scim.patchUser(tenant, idOf(request), objectBody(request)));
  });
  app.delete('/Users/:id', route, async (request, reply) => {
    const tenant = await authenticate(request, reply);
    return send(reply, await ctx.scim.deleteUser(tenant, idOf(request)));
  });
  app.get('/ServiceProviderConfig', route, async (request, reply) => {
    await authenticate(request, reply);
    return send(reply, { status: 200, body: ctx.scim.discovery('serviceProviderConfig') });
  });
  app.get('/ResourceTypes', route, async (request, reply) => {
    await authenticate(request, reply);
    return send(reply, { status: 200, body: ctx.scim.discovery('resourceTypes') });
  });
  app.get('/Schemas', route, async (request, reply) => {
    await authenticate(request, reply);
    return send(reply, { status: 200, body: ctx.scim.discovery('schemas') });
  });
}
