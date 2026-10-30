/**
 * Public API `/api/v1` (X-API-KEY). Routes are declared in one table that drives both the Fastify
 * registration and the OpenAPI 3.1 document at `/api/v1/openapi.json`.
 */
import type { NodeProperty } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, loadApiKey } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import {
  credentialCreateSchema,
  idParams,
  tagSchema,
  variableCreateSchema,
  variableUpdateSchema,
  workflowCreateSchema,
  workflowUpdateSchema,
} from '../http/schemas';
import { hasRole } from '../services/auth';
import { createCredential, deleteCredential } from './credentials';
import { deleteExecution, executionListQuery, getExecution, listExecutions } from './executions';
import { createTag, createVariable, renameTag, tagDTO, updateVariable, variableDTO } from './resources';

interface Input {
  auth: AuthContext;
  params: any;
  query: any;
  body: any;
  request: FastifyRequest;
}

interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  tag: string;
  role: Role;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** component schema name of `data` in the response */
  response: string;
  list?: boolean;
  handler(ctx: ServerContext, input: Input): Promise<unknown>;
}

const publicWorkflowListQuery = z.object({
  active: z.stringbool().optional(),
  tagId: z.string().max(64).optional(),
  name: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});

const publicWorkflowUpdate = workflowUpdateSchema.extend({ versionId: z.uuid().optional() });
const executionGetQuery = z.object({ includeData: z.stringbool().default(false) });
const credentialTypeParams = z.object({ type: z.string().min(1).max(128) });

const actor = (input: Input) => ({ userId: input.auth.user.id, ip: input.request.ip });

export const PUBLIC_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/workflows',
    summary: 'List workflows',
    tag: 'Workflows',
    role: 'viewer',
    query: publicWorkflowListQuery,
    response: 'WorkflowSummary',
    list: true,
    handler: (ctx, { auth, query }) =>
      ctx.workflows.list(auth.tenant.id, {
        search: query.name,
        tagId: query.tagId,
        active: query.active,
        limit: query.limit,
        cursor: query.cursor,
      }),
  },
  {
    method: 'POST',
    path: '/workflows',
    summary: 'Create a workflow',
    tag: 'Workflows',
    role: 'editor',
    body: workflowCreateSchema,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflows.create(input.auth.tenant.id, input.body, actor(input)),
    }),
  },
  {
    method: 'GET',
    path: '/workflows/:id',
    summary: 'Get a workflow',
    tag: 'Workflows',
    role: 'viewer',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, { auth, params }) => ({
      data: await ctx.workflows.dto(auth.tenant.id, await ctx.workflows.get(auth.tenant.id, params.id)),
    }),
  },
  {
    method: 'PUT',
    path: '/workflows/:id',
    summary: 'Update a workflow (versionId enables optimistic concurrency)',
    tag: 'Workflows',
    role: 'editor',
    params: idParams,
    body: publicWorkflowUpdate,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflows.update(input.auth.tenant.id, input.params.id, input.body, actor(input)),
    }),
  },
  {
    method: 'DELETE',
    path: '/workflows/:id',
    summary: 'Delete a workflow',
    tag: 'Workflows',
    role: 'editor',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, input) => {
      await ctx.workflows.delete(input.auth.tenant.id, input.params.id, actor(input));
      return { data: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: '/workflows/:id/activate',
    summary: 'Activate a workflow',
    tag: 'Workflows',
    role: 'editor',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflows.setActive(input.auth.tenant.id, input.params.id, true, actor(input)),
    }),
  },
  {
    method: 'POST',
    path: '/workflows/:id/deactivate',
    summary: 'Deactivate a workflow',
    tag: 'Workflows',
    role: 'editor',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflows.setActive(input.auth.tenant.id, input.params.id, false, actor(input)),
    }),
  },
  {
    method: 'GET',
    path: '/executions',
    summary: 'List executions',
    tag: 'Executions',
    role: 'viewer',
    query: executionListQuery,
    response: 'Execution',
    list: true,
    handler: (ctx, { auth, query }) => listExecutions(ctx, auth.tenant.id, query),
  },
  {
    method: 'GET',
    path: '/executions/:id',
    summary: 'Get an execution (includeData=true adds the workflow snapshot and run data)',
    tag: 'Executions',
    role: 'viewer',
    params: idParams,
    query: executionGetQuery,
    response: 'Execution',
    handler: async (ctx, { auth, params, query }) => ({
      data: await getExecution(ctx, auth.tenant.id, params.id, query.includeData),
    }),
  },
  {
    method: 'DELETE',
    path: '/executions/:id',
    summary: 'Delete an execution',
    tag: 'Executions',
    role: 'editor',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, { auth, params }) => {
      await deleteExecution(ctx, auth.tenant.id, params.id);
      return { data: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: '/executions/:id/retry',
    summary: 'Retry a failed execution',
    tag: 'Executions',
    role: 'editor',
    params: idParams,
    body: z.object({ useCurrentWorkflow: z.boolean().optional() }),
    response: 'ExecutionRef',
    handler: async (ctx, { auth, params, body }) => {
      const { executionId } = await ctx.executions.retry(auth.tenant.id, params.id, {
        useCurrentWorkflow: body?.useCurrentWorkflow,
        userId: auth.user.id,
      });
      return { data: { executionId } };
    },
  },
  {
    method: 'POST',
    path: '/credentials',
    summary: 'Create a credential',
    tag: 'Credentials',
    role: 'editor',
    body: credentialCreateSchema,
    response: 'CredentialRef',
    handler: async (ctx, input) => ({
      data: await createCredential(
        ctx,
        input.auth.tenant.id,
        input.body,
        input.auth.user.id,
        input.request.ip,
      ),
    }),
  },
  {
    method: 'DELETE',
    path: '/credentials/:id',
    summary: 'Delete a credential',
    tag: 'Credentials',
    role: 'editor',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, input) => {
      await deleteCredential(
        ctx,
        input.auth.tenant.id,
        input.params.id,
        input.auth.user.id,
        input.request.ip,
      );
      return { data: { ok: true } };
    },
  },
  {
    method: 'GET',
    path: '/credentials/schema/:type',
    summary: 'JSON schema of the data of a credential type',
    tag: 'Credentials',
    role: 'viewer',
    params: credentialTypeParams,
    response: 'JsonSchema',
    handler: async (ctx, { params }) => {
      const type = ctx.registries.credentialTypes.getResolved(params.type);
      if (!type) throw ApiError.notFound('Credential type');
      return { data: credentialJsonSchema(type.properties) };
    },
  },
  {
    method: 'GET',
    path: '/tags',
    summary: 'List tags',
    tag: 'Tags',
    role: 'viewer',
    response: 'Tag',
    list: true,
    handler: async (ctx, { auth }) => ({
      data: (await ctx.repos.tags.list(auth.tenant.id)).map(tagDTO),
      nextCursor: null,
    }),
  },
  {
    method: 'POST',
    path: '/tags',
    summary: 'Create a tag',
    tag: 'Tags',
    role: 'editor',
    body: tagSchema,
    response: 'Tag',
    handler: async (ctx, { auth, body }) => ({ data: await createTag(ctx, auth.tenant.id, body.name) }),
  },
  {
    method: 'GET',
    path: '/tags/:id',
    summary: 'Get a tag',
    tag: 'Tags',
    role: 'viewer',
    params: idParams,
    response: 'Tag',
    handler: async (ctx, { auth, params }) => {
      const row = await ctx.repos.tags.get(auth.tenant.id, params.id);
      if (!row) throw ApiError.notFound('Tag');
      return { data: tagDTO(row) };
    },
  },
  {
    method: 'PUT',
    path: '/tags/:id',
    summary: 'Rename a tag',
    tag: 'Tags',
    role: 'editor',
    params: idParams,
    body: tagSchema,
    response: 'Tag',
    handler: async (ctx, { auth, params, body }) => ({
      data: await renameTag(ctx, auth.tenant.id, params.id, body.name),
    }),
  },
  {
    method: 'DELETE',
    path: '/tags/:id',
    summary: 'Delete a tag',
    tag: 'Tags',
    role: 'editor',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, { auth, params }) => {
      if (!(await ctx.repos.tags.delete(auth.tenant.id, params.id))) throw ApiError.notFound('Tag');
      return { data: { ok: true } };
    },
  },
  {
    method: 'GET',
    path: '/variables',
    summary: 'List variables',
    tag: 'Variables',
    role: 'viewer',
    response: 'Variable',
    list: true,
    handler: async (ctx, { auth }) => ({
      data: (await ctx.repos.variables.list(auth.tenant.id)).map(variableDTO),
      nextCursor: null,
    }),
  },
  {
    method: 'POST',
    path: '/variables',
    summary: 'Create a variable',
    tag: 'Variables',
    role: 'admin',
    body: variableCreateSchema,
    response: 'Variable',
    handler: async (ctx, { auth, body }) => ({
      data: await createVariable(ctx, auth.tenant.id, body.key, body.value),
    }),
  },
  {
    method: 'PUT',
    path: '/variables/:id',
    summary: 'Update a variable',
    tag: 'Variables',
    role: 'admin',
    params: idParams,
    body: variableUpdateSchema,
    response: 'Variable',
    handler: async (ctx, { auth, params, body }) => ({
      data: await updateVariable(ctx, auth.tenant.id, params.id, body),
    }),
  },
  {
    method: 'DELETE',
    path: '/variables/:id',
    summary: 'Delete a variable',
    tag: 'Variables',
    role: 'admin',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, { auth, params }) => {
      if (!(await ctx.repos.variables.delete(auth.tenant.id, params.id))) throw ApiError.notFound('Variable');
      return { data: { ok: true } };
    },
  },
];

/** JSON schema of credential data from the type's properties */
export function credentialJsonSchema(properties: NodeProperty[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of properties) {
    if (p.type === 'notice' || p.type === 'button') continue;
    let schema: Record<string, unknown>;
    switch (p.type) {
      case 'number':
        schema = { type: 'number' };
        break;
      case 'boolean':
        schema = { type: 'boolean' };
        break;
      case 'options':
        schema = { enum: (p.options ?? []).map((o) => (o as { value: unknown }).value) };
        break;
      case 'multiOptions':
        schema = {
          type: 'array',
          items: { enum: (p.options ?? []).map((o) => (o as { value: unknown }).value) },
        };
        break;
      case 'json':
        schema = { type: ['object', 'string'] };
        break;
      case 'collection':
      case 'fixedCollection':
        schema = { type: 'object' };
        break;
      default:
        schema = { type: 'string' };
    }
    if (p.description) schema.description = p.description;
    if (p.default !== undefined && p.default !== '' && !p.typeOptions?.password) schema.default = p.default;
    if (p.typeOptions?.password) schema.writeOnly = true;
    props[p.name] = schema;
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties: props, required, additionalProperties: true };
}

// ---------------------------------------------------------------------------------------------
// OpenAPI

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const COMPONENTS: Record<string, unknown> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
      },
    },
  },
  Ok: { type: 'object', properties: { ok: { type: 'boolean', const: true } } },
  Tag: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Variable: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      key: { type: 'string' },
      value: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkflowSummary: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      active: { type: 'boolean' },
      tags: { type: 'array', items: ref('TagRef') },
      nodeTypes: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TagRef: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
  Workflow: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      nodes: { type: 'array', items: { type: 'object' } },
      connections: { type: 'object' },
      settings: { type: 'object' },
      pinData: { type: 'object' },
      stickyNotes: { type: 'array', items: { type: 'object' } },
      active: { type: 'boolean' },
      versionId: { type: 'string', format: 'uuid' },
      tags: { type: 'array', items: ref('TagRef') },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Execution: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      workflowId: { type: ['string', 'null'] },
      workflowName: { type: 'string' },
      mode: { type: 'string' },
      status: { enum: ['new', 'running', 'success', 'error', 'canceled', 'waiting', 'crashed'] },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      stoppedAt: { type: ['string', 'null'], format: 'date-time' },
      durationMs: { type: ['number', 'null'] },
      errorMessage: { type: ['string', 'null'] },
      customData: { type: 'object' },
      workflowData: { type: 'object' },
      state: { type: 'object' },
    },
  },
  ExecutionRef: { type: 'object', properties: { executionId: { type: 'string', format: 'uuid' } } },
  CredentialRef: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { type: 'string' },
    },
  },
  JsonSchema: { type: 'object' },
};

export function buildOpenApiDocument(ctx: ServerContext): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of PUBLIC_ROUTES) {
    const path = route.path.replace(/:(\w+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const [location, schema] of [
      ['path', route.params],
      ['query', route.query],
    ] as const) {
      if (!schema) continue;
      const json = toJsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, s] of Object.entries(json.properties ?? {})) {
        parameters.push({
          name,
          in: location,
          required: location === 'path' || (json.required ?? []).includes(name),
          schema: s,
        });
      }
    }
    const dataSchema = route.list ? { type: 'array', items: ref(route.response) } : ref(route.response);
    const success = {
      type: 'object',
      required: ['data'],
      properties: route.list
        ? { data: dataSchema, nextCursor: { type: ['string', 'null'] } }
        : { data: dataSchema },
    };
    const errorResponse = (description: string) => ({
      description,
      content: { 'application/json': { schema: ref('Error') } },
    });
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      summary: route.summary,
      tags: [route.tag],
      operationId: `${route.method.toLowerCase()}${route.path.replace(/[/:](\w)/g, (_, c: string) => c.toUpperCase())}`,
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJsonSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: success } } },
        400: errorResponse('Invalid request'),
        401: errorResponse('Missing or invalid API key'),
        403: errorResponse(`Requires the ${route.role} role or higher`),
        404: errorResponse('Not found'),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${ctx.config.brand.name} Public API`,
      version: '1.0.0',
      description:
        'Manage workflows, executions, credentials, tags and variables of one workspace. Authenticate with an API key in the X-API-KEY header. Lists use cursor pagination: pass `nextCursor` as `cursor`.',
    },
    servers: [{ url: `${ctx.config.baseUrl}/api/v1` }],
    security: [{ ApiKey: [] }],
    tags: [...new Set(PUBLIC_ROUTES.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-KEY' } },
      schemas: COMPONENTS,
    },
  };
}

export async function publicApiPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  let document: Record<string, unknown> | undefined;
  app.get('/openapi.json', async () => {
    document ??= buildOpenApiDocument(ctx);
    return document;
  });

  for (const route of PUBLIC_ROUTES) {
    app.route({
      method: route.method,
      url: route.path,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: 60_000,
          keyGenerator: (request: FastifyRequest) =>
            `api:${String(request.headers['x-api-key'] ?? request.ip).slice(0, 20)}`,
        },
      },
      handler: async (request) => {
        await loadApiKey(request, ctx.auth);
        const auth = request.auth!;
        if (!hasRole(auth.role, route.role)) throw ApiError.forbidden();
        const input: Input = {
          auth,
          request,
          params: route.params ? parse(route.params, request.params) : {},
          query: route.query ? parse(route.query, request.query) : {},
          body: route.body ? parse(route.body, request.body ?? {}) : undefined,
        };
        return route.handler(ctx, input);
      },
    });
  }
}
