/** /rest/credentials/* and /rest/oauth2/* */
import { randomBytes } from 'node:crypto';
import type { DataObject, Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { CredentialRow, ProjectRow } from '../db/schema';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import {
  credentialCreateSchema,
  credentialTestSchema,
  credentialUpdateSchema,
  idParams,
} from '../http/schemas';
import { toWorkflowLogger } from '../logger';
import { MISSING_SCOPE_MESSAGE } from '../services/access';
import { testCredential } from '../services/credential-test';
import { NOT_PRIVATE_MESSAGE, type OAuthCallbackSession, oauthCallbackPage } from '../services/oauth2';
import { credentialReadErrorText, resolvedValues, scrubValues } from '../services/secrets/resolver';

/** P6-24, P6-15: the body fields the editor sends beyond the Phase 5 schemas (editor api/types.ts) */
const createBody = credentialCreateSchema.extend({
  projectId: z.uuid().optional(),
  isResolvable: z.boolean().optional(),
});
const updateBody = credentialUpdateSchema.extend({
  isGlobal: z.boolean().optional(),
  isResolvable: z.boolean().optional(),
});
const testBody = credentialTestSchema.extend({ projectId: z.uuid().optional() });
const queryFlag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .transform((value) => value === true || value === 'true');
const listQuery = z.object({
  type: z.string().max(128).optional(),
  projectId: z.uuid().optional(),
  onlySharedWithMe: queryFlag,
  includeScopes: queryFlag,
});

type ProjectRef = Pick<ProjectRow, 'id' | 'name' | 'type' | 'icon'>;

export function credentialSummary(
  row: Pick<CredentialRow, 'id' | 'name' | 'type' | 'createdAt' | 'updatedAt'>,
) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectRef(row: ProjectRef): ProjectRef {
  return { id: row.id, name: row.name, type: row.type, icon: row.icon ?? null };
}

/** the caller's scopes on one credential, `credential:*` only (n8n's resource scopes), sorted */
async function credentialScopes(
  ctx: ServerContext,
  auth: AuthContext,
  credentialId: string,
): Promise<Scope[]> {
  const scopes = await ctx.access.scopesForAuth(auth, { credentialId });
  return [...scopes].filter((scope) => scope.startsWith('credential:')).sort();
}

/** the access fields of one credential: owning project, the projects it is shared with, the global flag */
async function accessFields(
  ctx: ServerContext,
  tenantId: string,
  row: Pick<CredentialRow, 'id' | 'projectId' | 'isGlobal'>,
) {
  const home = await ctx.repos.projects.get(tenantId, row.projectId);
  const shares = await ctx.repos.shares.listForCredential(tenantId, row.id);
  return {
    projectId: row.projectId,
    homeProject: home ? projectRef(home) : null,
    sharedWithProjects: shares.map((share) => projectRef(share.project)),
    isGlobal: row.isGlobal,
  };
}

/**
 * P6-15: the private fields of credential rows: `isResolvable` on each, and for the private ones the caller's
 * `connectedByMe` and the `connectedCount` of every user (one query each for the whole list).
 */
async function privateFields(
  ctx: ServerContext,
  auth: AuthContext,
  ids: string[],
): Promise<Map<string, { isResolvable: boolean; connectedByMe?: boolean; connectedCount?: number }>> {
  const resolvable = await ctx.repos.credentialEntries.resolvableIds(auth.tenant.id, ids);
  const status = await ctx.privateCredentials.connectedStatus(auth.tenant.id, auth.user.id, [...resolvable]);
  return new Map(
    ids.map((id) => [id, resolvable.has(id) ? { isResolvable: true, ...status.get(id) } : { isResolvable: false }]),
  );
}

export async function createCredential(
  ctx: ServerContext,
  tenantId: string,
  body: z.output<typeof credentialCreateSchema> & { projectId: string; isResolvable?: boolean },
  userId: string,
  ip: string,
) {
  const row = await ctx.credentials.create(
    tenantId,
    {
      name: body.name,
      type: body.type,
      data: body.data as DataObject,
      projectId: body.projectId,
      isResolvable: body.isResolvable === true,
    },
    userId,
  );
  await ctx.repos.audit.add(tenantId, {
    userId,
    action: 'credential.created',
    resourceType: 'credential',
    resourceId: row.id,
    metadata: { type: row.type, ...(row.isResolvable ? { isResolvable: true } : {}) },
    ip,
  });
  return { id: row.id, name: row.name, type: row.type };
}

export async function deleteCredential(
  ctx: ServerContext,
  tenantId: string,
  id: string,
  userId: string,
  ip: string,
) {
  // P6-15: deleting a private credential also needs `credential:createEndUser` (n8n), on every path (REST,
  // public API, assistant); the caller's `credential:delete` is each path's own check
  if ((await ctx.repos.credentials.get(tenantId, id))?.isResolvable) {
    const scopes = await ctx.access.scopesFor(tenantId, userId, { credentialId: id });
    if (!scopes.has('credential:createEndUser')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
  }
  if (!(await ctx.repos.credentials.delete(tenantId, id))) throw ApiError.notFound('Credential');
  await ctx.repos.audit.add(tenantId, {
    userId,
    action: 'credential.deleted',
    resourceType: 'credential',
    resourceId: id,
    ip,
  });
}

/** P6-15: the signed-in user of an OAuth callback (the popup carries the session cookie), if any */
function callbackSession(request: FastifyRequest): OAuthCallbackSession | undefined {
  const auth = request.auth;
  return auth ? { tenantId: auth.tenant.id, userId: auth.user.id } : undefined;
}

/** a string field of the raw body, read before validation so the scope gate answers first */
function rawField(request: FastifyRequest, key: string): string | undefined {
  const body = request.body;
  if (body === null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The gate of the OAuth authorize routes: `credential:update` on the credential of the query (a token
 * write-back); with no id in the query, the global scope, so a caller who holds none is refused first.
 */
async function requireCredentialUpdate(request: FastifyRequest): Promise<AuthContext> {
  const query = request.query as Record<string, unknown> | undefined;
  const credentialId = typeof query?.credentialId === 'string' ? query.credentialId : undefined;
  return credentialId
    ? requireScope(request, 'credential:update', { credentialId })
    : requireScope(request, 'credential:update');
}

export function registerCredentialRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, credentials, config } = ctx;
  // a process that serves routes reads `$secrets` even before startMain
  credentials.useSecrets(ctx.secrets);

  // names and types only (the editor shows which credential a node uses), never data. P6-24: the list
  // passes the access filter (owned by or shared with the caller's projects, or global)
  app.get('/credentials', async (request) => {
    const auth = requireAuth(request);
    const tenantId = auth.tenant.id;
    const query = parse(listQuery, request.query);
    const filter = await ctx.access.listFilter(auth, 'credential:list');
    let projectId = query.projectId;
    if (query.onlySharedWithMe) {
      // n8n: the rows shared into the caller's personal project
      const personal = await repos.projects.getPersonal(tenantId, auth.user.id);
      if (!personal) return { data: [], nextCursor: null };
      projectId = personal.id;
    }
    const rows = await repos.credentials.list(tenantId, {
      type: query.type,
      filter,
      projectId,
      onlySharedWithMe: query.onlySharedWithMe,
    });
    const projects = new Map((await repos.projects.listAll(tenantId)).map((p) => [p.id, projectRef(p)]));
    const shared = new Map<string, ProjectRef[]>();
    for (const share of await repos.shares.sharesInto(tenantId, 'credential', [...projects.keys()])) {
      const project = projects.get(share.projectId);
      if (project) shared.set(share.resourceId, [...(shared.get(share.resourceId) ?? []), project]);
    }
    const privates = await privateFields(
      ctx,
      auth,
      rows.map((row) => row.id),
    );
    const data = [];
    for (const row of rows) {
      data.push({
        ...credentialSummary(row),
        projectId: row.projectId,
        homeProject: projects.get(row.projectId) ?? null,
        sharedWithProjects: shared.get(row.id) ?? [],
        isGlobal: row.isGlobal,
        ...privates.get(row.id),
        ...(query.includeScopes ? { scopes: await credentialScopes(ctx, auth, row.id) } : {}),
      });
    }
    return { data, nextCursor: null };
  });

  // P6-24: into the body's project (else the caller's personal project) with `credential:create` there
  app.post('/credentials', async (request) => {
    const auth = requireAuth(request);
    const projectId = await ctx.access.targetProject(auth, rawField(request, 'projectId'));
    await requireScope(request, 'credential:create', { projectId });
    const body = parse(createBody, request.body);
    // P6-15: a private credential needs `credential:createEndUser` in the project, an OAuth type and a team project
    if (body.isResolvable) {
      await requireScope(request, 'credential:createEndUser', { projectId });
      await ctx.privateCredentials.assertCanBePrivate(auth.tenant.id, body.type, projectId);
    }
    return {
      data: await createCredential(ctx, auth.tenant.id, { ...body, projectId }, auth.user.id, request.ip),
    };
  });

  // a project viewer reads it too (n8n); secret fields stay redacted
  app.get('/credentials/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:read', { credentialId: id });
    const row = await repos.credentials.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Credential');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'credential.read',
      resourceType: 'credential',
      resourceId: id,
      ip: request.ip,
    });
    return {
      data: {
        ...credentialSummary(row),
        data: credentials.redacted(row),
        ...(await accessFields(ctx, auth.tenant.id, row)),
        ...(await privateFields(ctx, auth, [row.id])).get(row.id),
        scopes: await credentialScopes(ctx, auth, id),
      },
    };
  });

  app.patch('/credentials/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:update', { credentialId: id });
    const body = parse(updateBody, request.body);
    // usable by every member: a workspace scope (owner and admin), as n8n
    if (body.isGlobal !== undefined) await requireScope(request, 'credential:shareGlobally');
    // P6-15: the switch between fixed and private needs `credential:createEndUser` on the credential; to
    // private also an OAuth type in a team project
    if (body.isResolvable !== undefined) {
      const current = await repos.credentials.get(auth.tenant.id, id);
      if (!current) throw ApiError.notFound('Credential');
      if (body.isResolvable !== current.isResolvable) {
        await requireScope(request, 'credential:createEndUser', { credentialId: id });
        if (body.isResolvable) {
          await ctx.privateCredentials.assertCanBePrivate(auth.tenant.id, current.type, current.projectId);
        }
      }
    }
    const row = await credentials.update(auth.tenant.id, id, {
      name: body.name,
      data: body.data as DataObject,
      isGlobal: body.isGlobal,
      isResolvable: body.isResolvable,
    });
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'credential.updated',
      resourceType: 'credential',
      resourceId: id,
      ...(body.isGlobal !== undefined || body.isResolvable !== undefined
        ? {
            metadata: {
              ...(body.isGlobal !== undefined ? { isGlobal: body.isGlobal } : {}),
              ...(body.isResolvable !== undefined ? { isResolvable: body.isResolvable } : {}),
            },
          }
        : {}),
      ip: request.ip,
    });
    return {
      data: {
        id: row.id,
        name: row.name,
        type: row.type,
        projectId: row.projectId,
        isGlobal: row.isGlobal,
        ...(await privateFields(ctx, auth, [row.id])).get(row.id),
        scopes: await credentialScopes(ctx, auth, id),
      },
    };
  });

  app.delete('/credentials/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:delete', { credentialId: id });
    await deleteCredential(ctx, auth.tenant.id, id, auth.user.id, request.ip);
    return { data: { ok: true } };
  });

  // P6-15: the caller's own connection of a private credential: the provider's consent URL, whose signed state
  // marks the per user target (the callback writes the caller's entry, never the shared row)
  app.post('/credentials/:id/authorize', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, 'credential:connect', { credentialId: id });
    const row = await repos.credentials.get(auth.tenant.id, id);
    if (!row) throw ApiError.notFound('Credential');
    const perUser = { perUser: true };
    let url: string;
    if (credentials.types.isA(row.type, 'oAuth2Api')) {
      // an MCP credential's first automatic registration writes the shared row: only with credential:update
      const registerClient = (await ctx.access.scopesForAuth(auth, { credentialId: id })).has(
        'credential:update',
      );
      url = await ctx.oauth2.authorizeUrl(auth.tenant.id, auth.user.id, id, { ...perUser, registerClient });
    } else if (credentials.types.isA(row.type, 'oAuth1Api')) {
      url = await ctx.oauth1.authorizeUrl(auth.tenant.id, auth.user.id, id, perUser);
    } else {
      throw ApiError.badRequest(NOT_PRIVATE_MESSAGE);
    }
    return { data: { url } };
  });

  // session only, as n8n: a user who lost access to the credential may still clear their own row
  app.delete('/credentials/:id/my-connection', async (request) => {
    const { id } = parse(idParams, request.params);
    const auth = requireAuth(request);
    await ctx.privateCredentials.deleteMine(auth, id);
    return { data: { ok: true } };
  });

  // P6-24: the data resolves `$secrets` and `$vars` under one project: a stored credential's own (with
  // `credential:read` on it; the body data counts only with `credential:update`), else the body's project
  // (else the default) with `credential:create` there
  app.post('/credentials/test', async (request) => {
    const auth = requireAuth(request);
    const storedId = rawField(request, 'id');
    let projectId: string;
    let row: CredentialRow | undefined;
    if (storedId !== undefined) {
      await requireScope(request, 'credential:read', { credentialId: storedId });
      row = await repos.credentials.get(auth.tenant.id, storedId);
      if (!row) throw ApiError.notFound('Credential');
      projectId = row.projectId;
    } else {
      projectId = await ctx.access.targetProject(auth, rawField(request, 'projectId'));
      await requireScope(request, 'credential:create', { projectId });
    }
    const body = parse(testBody, request.body);
    let data = body.data as DataObject;
    if (row) {
      if (row.type !== body.type) throw ApiError.badRequest('The credential type does not match');
      const stored = credentials.decrypt(row);
      // as n8n: without credential:update (a viewer, a sharee, anyone on a global credential) the body is
      // ignored and the stored data is tested as is, so no caller can redirect the stored secret
      const canUpdate = (await ctx.access.scopesForAuth(auth, { credentialId: row.id })).has(
        'credential:update',
      );
      data = canUpdate ? credentials.merge(stored, data) : stored;
    }
    credentials.resolvedType(body.type);
    let resolved: DataObject;
    try {
      resolved = await credentials.resolveData(auth.tenant.id, projectId, data);
    } catch (error) {
      return { data: { status: 'Error', message: credentialReadErrorText(error) } };
    }
    const result = await testCredential(credentials, ctx.http, body.type, resolved, {
      nodeTypes: ctx.registries.nodeTypes,
      tenantId: auth.tenant.id,
      logger: toWorkflowLogger(ctx.logger),
      // P6-16: a JWE credential's token answer opens with the workspace's key, as on a run
      oauthTokenDecrypt: (token, data) => ctx.oauthJwe.decryptResponse(auth.tenant.id, token, data),
    });
    // a client error can quote the URL or header it was given, which may be a vault value
    return { data: { ...result, message: scrubValues(result.message, resolvedValues(data, resolved)) } };
  });

  app.get('/oauth1/authorize', async (request) => {
    const auth = await requireCredentialUpdate(request);
    const { credentialId } = parse(z.object({ credentialId: z.uuid() }), request.query);
    return { data: { url: await ctx.oauth1.authorizeUrl(auth.tenant.id, auth.user.id, credentialId) } };
  });

  const popupReply = (reply: FastifyReply, status: number, nonce: string, body: string) =>
    reply
      .status(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`)
      .header('cache-control', 'no-store')
      // the page came back from the provider's origin: keep its opener so it can post the result
      .header('cross-origin-opener-policy', 'unsafe-none')
      .send(body);

  // the provider redirects the popup here; the signed state (not the session) identifies the tenant. A per
  // user state (P6-15) also needs the session's user to be the state's (`callbackSession`)
  app.get('/oauth1/callback', { logLevel: 'warn' }, async (request, reply) => {
    const query = parse(
      z.object({
        oauth_token: z.string().max(1024).optional(),
        oauth_verifier: z.string().max(1024).optional(),
        denied: z.string().max(1024).optional(),
        state: z.string().max(8192).optional(),
      }),
      request.query,
    );
    const nonce = randomBytes(16).toString('base64');
    const origin = new URL(config.baseUrl).origin;
    try {
      if (!query.state) throw ApiError.badRequest('The authorization response is incomplete');
      const result = await ctx.oauth1.callback(query, query.state, callbackSession(request));
      return popupReply(
        reply,
        200,
        nonce,
        oauthCallbackPage(origin, nonce, { status: 'success', credentialId: result.credentialId }),
      );
    } catch (error) {
      return popupReply(
        reply,
        400,
        nonce,
        oauthCallbackPage(origin, nonce, {
          status: 'error',
          message: (error as Error).message.slice(0, 300),
        }),
      );
    }
  });

  // P5-18: the Client ID Metadata Document an MCP authorization server fetches when our URL is the client
  // id. Public by design (no session): it holds only this instance's name and callback URL.
  app.get('/oauth2/mcp-client-metadata', async (_request, reply) =>
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(ctx.oauth2.clientMetadata()),
  );

  app.get('/oauth2/authorize', async (request) => {
    const auth = await requireCredentialUpdate(request);
    const { credentialId } = parse(z.object({ credentialId: z.uuid() }), request.query);
    return { data: { url: await ctx.oauth2.authorizeUrl(auth.tenant.id, auth.user.id, credentialId) } };
  });

  // the provider redirects the popup here; the signed state (not the session) identifies the tenant. A per
  // user state (P6-15) also needs the session's user to be the state's (`callbackSession`)
  app.get('/oauth2/callback', { logLevel: 'warn' }, async (request, reply) => {
    const query = parse(
      z.object({
        code: z.string().max(4096).optional(),
        state: z.string().max(8192).optional(),
        error: z.string().max(256).optional(),
        error_description: z.string().max(1024).optional(),
      }),
      request.query,
    );
    const nonce = randomBytes(16).toString('base64');
    const origin = new URL(config.baseUrl).origin;
    let body: string;
    let status = 200;
    try {
      if (query.error) throw ApiError.badRequest(query.error_description ?? query.error);
      if (!query.code || !query.state) throw ApiError.badRequest('The authorization response is incomplete');
      const result = await ctx.oauth2.callback(query.code, query.state, callbackSession(request));
      body = oauthCallbackPage(origin, nonce, { status: 'success', credentialId: result.credentialId });
    } catch (error) {
      status = 400;
      body = oauthCallbackPage(origin, nonce, {
        status: 'error',
        message: (error as Error).message.slice(0, 300),
      });
    }
    return (
      reply
        .status(status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`)
        .header('cache-control', 'no-store')
        // the page came back from the provider's origin: keep its opener so it can post the result
        .header('cross-origin-opener-policy', 'unsafe-none')
        .send(body)
    );
  });
}
