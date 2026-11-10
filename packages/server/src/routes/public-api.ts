/**
 * Public API `/api/v1` (X-API-KEY). Routes are declared in one table that drives both the Fastify
 * registration and the OpenAPI 3.1 document at `/api/v1/openapi.json`.
 */
import type { NodeProperty, Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type ApiKeyScope, assertApiKeyScope } from '../http/api-key-scopes';
import { type AuthContext, loadApiKey, requireScope } from '../http/auth';
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
import type { AccessTarget } from '../services/access';
import { createCredential, deleteCredential } from './credentials';
import { deleteExecution, executionListQuery, getExecution, listExecutions } from './executions';
import { PUBLIC_DATA_TABLE_ROUTES } from './public-data-tables';
import { PUBLIC_EVALUATION_ROUTES } from './public-evaluations';
import { PUBLIC_FOLDER_ROUTES } from './public-folders';
import { PUBLIC_LDAP_ROUTES } from './public-ldap';
import { PUBLIC_PROJECT_ROUTES } from './public-projects';
import { PUBLIC_ROLE_MAPPING_ROUTES } from './public-role-mapping';
import { PUBLIC_ROLE_ROUTES } from './public-roles';
import { PUBLIC_SECURITY_POLICY_ROUTES } from './public-security-policy';
import { PUBLIC_SSO_ROUTES } from './public-sso';
import { PUBLIC_USER_ROUTES } from './public-users';
import { createTag, projectVariableDTO, renameTag, tagDTO } from './resources';

export interface PublicApiInput {
  auth: AuthContext;
  params: any;
  query: any;
  body: any;
  request: FastifyRequest;
  /** a create route (`access.create`): the project the dispatcher resolved with `targetProject` and checked */
  projectId?: string;
}

/** what a row's `target` reads: the request as it arrived, before the schemas ran */
export interface RouteRequest {
  params: any;
  query: any;
  body: any;
}

/** the row of the access model that `target` names (`AccessService` resolves it; another workspace's id is 404) */
export type RouteTarget = (request: RouteRequest) => AccessTarget | undefined;

/**
 * Who may call a row (P6-34). The user's scope is checked on the row it names; the API key scope
 * (`ApiRoute.scope`) is a second check, so a call needs both.
 * - `scope` (and `target`): the user must hold one of the scopes on the target, else 403
 *   "User is missing a scope required to perform this action"; no target = the workspace scopes.
 * - `list`: any key may call; the handler narrows its rows to `AccessService.listFilter`. With a `target`
 *   (a `projectId` in the query) the scope is checked on it first.
 * - `create`: the project is the body's `projectId`, else the workspace default (`targetProject`); the scope is
 *   checked in it and the handler gets it as `input.projectId`.
 * - `open`: any signed-in key (static answers).
 */
export type RouteAccess =
  | { scope: Scope | readonly Scope[]; target?: RouteTarget; list?: undefined; create?: undefined }
  | { scope: Scope | readonly Scope[]; list: true; target?: RouteTarget; create?: undefined }
  | { scope: Scope; create: true; target?: undefined; list?: undefined }
  | { open: true };

export interface ApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  tag: string;
  /** who may call it, by the user's scopes (checked first) */
  access: RouteAccess;
  /** the API key scope of this route (n8n's); a key needs it as well as `access` */
  scope?: ApiKeyScope;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** component schema name of `data` in the response */
  response: string;
  list?: boolean;
  /** the success status when it is not 200 (P5-12: a created test run answers 201) */
  status?: 201 | 202;
  handler(ctx: ServerContext, input: PublicApiInput): Promise<unknown>;
}

const publicWorkflowListQuery = z.object({
  active: z.stringbool().optional(),
  /** only the workflows of this project; a project the key's user holds nothing in, or a missing one, lists nothing */
  projectId: z.uuid().optional(),
  tagId: z.string().max(64).optional(),
  name: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});

const publicWorkflowUpdate = workflowUpdateSchema.extend({ versionId: z.uuid().optional() });
/** P3-10: PUT on a published workflow publishes the new version unless publishIfActive=false */
const publicWorkflowUpdateQuery = z.object({ publishIfActive: z.enum(['true', 'false']).default('true') });
/** P3-10: n8n's publish body */
const publicPublishBody = z.object({
  versionId: z.uuid().optional(),
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2000).optional(),
});
/** P6-34: a variable is global, or belongs to a project; `state=empty` keeps the ones with no value */
const publicVariableListQuery = z.object({
  projectId: z.uuid().optional(),
  state: z.enum(['empty']).optional(),
});
const publicVariableCreate = variableCreateSchema.extend({ projectId: z.uuid().nullish() });
const publicVariableUpdate = variableUpdateSchema.extend({ projectId: z.uuid().nullable().optional() });
/** P6-34: a workflow or credential is created in the project the body names (else the default) */
const publicWorkflowCreate = workflowCreateSchema.extend({ projectId: z.uuid().nullish() });
const publicCredentialCreate = credentialCreateSchema.extend({ projectId: z.uuid().nullish() });
const executionGetQuery = z.object({ includeData: z.stringbool().default(false) });
const credentialTypeParams = z.object({ type: z.string().min(1).max(128) });

const onWorkflow: RouteTarget = ({ params }) => ({ workflowId: params.id });
const onExecution: RouteTarget = ({ params }) => ({ executionId: params.id });

const actor = (input: PublicApiInput) => ({ userId: input.auth.user.id, ip: input.request.ip });

export const PUBLIC_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/workflows',
    summary: 'List workflows',
    tag: 'Workflows',
    access: { scope: 'workflow:list', list: true },
    scope: 'workflow:list',
    query: publicWorkflowListQuery,
    response: 'WorkflowSummary',
    list: true,
    // the rows are the caller's: `listFor` narrows them to the `workflow:list` access filter
    handler: (ctx, { auth, query }) =>
      ctx.workflows.listFor(
        auth,
        {
          search: query.name,
          tagId: query.tagId,
          active: query.active,
          projectId: query.projectId,
          limit: query.limit,
          cursor: query.cursor,
        },
        // a project the key's user holds nothing in answers an empty list, as n8n (not 403)
        { unheldProject: 'narrow' },
      ),
  },
  {
    method: 'POST',
    path: '/workflows',
    summary: 'Create a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:create', create: true },
    scope: 'workflow:create',
    body: publicWorkflowCreate,
    response: 'Workflow',
    handler: async (ctx, input) => {
      const { projectId: _named, ...body } = input.body;
      const created = await ctx.workflows.create(
        input.auth.tenant.id,
        { ...body, projectId: input.projectId },
        actor(input),
      );
      return { data: await ctx.workflows.dtoFor(input.auth, created) };
    },
  },
  {
    method: 'GET',
    path: '/workflows/:id',
    summary: 'Get a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'workflow:read',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, { auth, params }) => {
      const row = await ctx.workflows.get(auth.tenant.id, params.id);
      return { data: await ctx.workflows.dtoFor(auth, await ctx.workflows.dto(auth.tenant.id, row), row) };
    },
  },
  {
    method: 'PUT',
    path: '/workflows/:id',
    summary: 'Update a workflow (versionId enables optimistic concurrency)',
    tag: 'Workflows',
    access: { scope: 'workflow:update', target: onWorkflow },
    scope: 'workflow:update',
    params: idParams,
    query: publicWorkflowUpdateQuery,
    body: publicWorkflowUpdate,
    response: 'Workflow',
    handler: async (ctx, input) => {
      // P6-34: putting a new version live is a publish: the key needs workflow:activate and the user
      // workflow:publish on the workflow (personal space publishing off and custom roles apply). Without
      // either the draft is saved and a published workflow answers 403 with the draft's versionId (as n8n)
      let reason: 'insufficient_api_key_scope' | 'insufficient_permissions' | undefined;
      if (input.query.publishIfActive !== 'false') {
        const keyScopes = input.auth.apiKeyScopes;
        if (keyScopes && keyScopes.length > 0 && !keyScopes.includes('workflow:activate')) {
          reason = 'insufficient_api_key_scope';
        } else if (
          !(await ctx.access.scopesForAuth(input.auth, { workflowId: input.params.id })).has(
            'workflow:publish',
          )
        ) {
          reason = 'insufficient_permissions';
        }
      }
      const saved = await ctx.workflows.update(
        input.auth.tenant.id,
        input.params.id,
        input.body,
        actor(input),
        undefined,
        { publishIfActive: input.query.publishIfActive !== 'false' && !reason },
      );
      if (reason && saved.active) {
        throw new ApiError(
          403,
          'forbidden',
          reason === 'insufficient_api_key_scope'
            ? "Couldn't publish the workflow: the API key lacks the workflow:activate scope. The changes were saved as a draft."
            : "Couldn't publish the workflow: you lack the workflow:publish scope on it. The changes were saved as a draft.",
          { reason, versionId: saved.versionId },
        );
      }
      return { data: saved };
    },
  },
  {
    method: 'DELETE',
    path: '/workflows/:id',
    summary: 'Delete a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:delete', target: onWorkflow },
    scope: 'workflow:delete',
    params: idParams,
    response: 'Ok',
    handler: async (ctx, input) => {
      // the public API deletes without archiving first (as n8n deleteForPublicApi)
      await ctx.workflows.delete(input.auth.tenant.id, input.params.id, actor(input), { force: true });
      return { data: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: '/workflows/:id/activate',
    summary: 'Publish a workflow (a version, optionally named; default the current one)',
    tag: 'Workflows',
    access: { scope: 'workflow:publish', target: onWorkflow },
    scope: 'workflow:activate',
    params: idParams,
    body: publicPublishBody,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflows.setActive(input.auth.tenant.id, input.params.id, true, actor(input), {
        versionId: input.body?.versionId,
        versionName: input.body?.name,
        description: input.body?.description,
      }),
    }),
  },
  {
    method: 'POST',
    path: '/workflows/:id/archive',
    summary: 'Archive a workflow (unpublishes it; archiving an archived workflow is a no-op)',
    tag: 'Workflows',
    access: { scope: 'workflow:delete', target: onWorkflow },
    scope: 'workflow:delete',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflowArchive.archive(input.auth.tenant.id, input.params.id, actor(input), {
        publicApi: true,
      }),
    }),
  },
  {
    method: 'POST',
    path: '/workflows/:id/unarchive',
    summary: 'Unarchive a workflow (stays unpublished)',
    tag: 'Workflows',
    access: { scope: 'workflow:delete', target: onWorkflow },
    scope: 'workflow:delete',
    params: idParams,
    response: 'Workflow',
    handler: async (ctx, input) => ({
      data: await ctx.workflowArchive.unarchive(input.auth.tenant.id, input.params.id, actor(input)),
    }),
  },
  {
    method: 'POST',
    path: '/workflows/:id/deactivate',
    summary: 'Deactivate a workflow',
    tag: 'Workflows',
    access: { scope: 'workflow:unpublish', target: onWorkflow },
    scope: 'workflow:deactivate',
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
    access: { scope: 'execution:list', list: true },
    scope: 'execution:list',
    query: executionListQuery,
    response: 'Execution',
    list: true,
    // an execution is listed when its workflow is (`execution:list` access filter)
    handler: async (ctx, { auth, query }) =>
      listExecutions(ctx, auth.tenant.id, query, {
        filter: await ctx.access.listFilter(auth, 'execution:list'),
      }),
  },
  {
    method: 'GET',
    path: '/executions/:id',
    summary: 'Get an execution (includeData=true adds the workflow snapshot and run data)',
    tag: 'Executions',
    access: { scope: 'execution:read', target: onExecution },
    scope: 'execution:read',
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
    access: { scope: 'execution:delete', target: onExecution },
    scope: 'execution:delete',
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
    access: { scope: 'workflow:execute', target: onExecution },
    scope: 'execution:retry',
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
    access: { scope: 'credential:create', create: true },
    scope: 'credential:create',
    body: publicCredentialCreate,
    response: 'CredentialRef',
    handler: async (ctx, input) => ({
      data: await createCredential(
        ctx,
        input.auth.tenant.id,
        { ...input.body, projectId: input.projectId },
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
    access: { scope: 'credential:delete', target: ({ params }) => ({ credentialId: params.id }) },
    scope: 'credential:delete',
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
    access: { open: true },
    scope: 'credential:read',
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
    access: { scope: 'tag:list' },
    scope: 'tag:list',
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
    access: { scope: 'tag:create' },
    scope: 'tag:create',
    body: tagSchema,
    response: 'Tag',
    handler: async (ctx, { auth, body }) => ({ data: await createTag(ctx, auth.tenant.id, body.name) }),
  },
  {
    method: 'GET',
    path: '/tags/:id',
    summary: 'Get a tag',
    tag: 'Tags',
    access: { scope: 'tag:read' },
    scope: 'tag:read',
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
    access: { scope: 'tag:update' },
    scope: 'tag:update',
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
    access: { scope: 'tag:delete' },
    scope: 'tag:delete',
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
    summary: 'List variables (projectId: one project; state=empty: only variables with no value)',
    tag: 'Variables',
    scope: 'variable:list',
    access: {
      scope: ['variable:list', 'projectVariable:list'],
      list: true,
      target: ({ query }) =>
        typeof query.projectId === 'string' ? { projectId: query.projectId } : undefined,
    },
    query: publicVariableListQuery,
    response: 'Variable',
    list: true,
    handler: async (ctx, { auth, query }) => {
      const rows = await ctx.variables.list(
        auth,
        query.projectId === undefined ? {} : { projectId: query.projectId },
      );
      const shown = query.state === 'empty' ? rows.filter((row) => row.value === '') : rows;
      return { data: shown.map(projectVariableDTO), nextCursor: null };
    },
  },
  {
    method: 'POST',
    path: '/variables',
    summary: 'Create a variable (projectId makes it a project variable)',
    tag: 'Variables',
    scope: 'variable:create',
    // no `create: true`: a variable with no `projectId` is a workspace variable (global scopes), not one of the
    // default project, so `targetProject` would change what the call makes; plan-S1 L13: "variables by projectId"
    access: {
      scope: ['variable:create', 'projectVariable:create'],
      target: ({ body }) => (typeof body?.projectId === 'string' ? { projectId: body.projectId } : undefined),
    },
    body: publicVariableCreate,
    response: 'Variable',
    handler: async (ctx, { auth, body }) => ({
      data: projectVariableDTO(await ctx.variables.create(auth, body)),
    }),
  },
  {
    method: 'PUT',
    path: '/variables/:id',
    summary: 'Update a variable (projectId moves it between global and a project)',
    tag: 'Variables',
    scope: 'variable:update',
    access: {
      scope: ['variable:update', 'projectVariable:update'],
      target: ({ params }) => ({ variableId: params.id }),
    },
    params: idParams,
    body: publicVariableUpdate,
    response: 'Variable',
    handler: async (ctx, { auth, params, body }) => ({
      data: projectVariableDTO(await ctx.variables.update(auth, params.id, body)),
    }),
  },
  {
    method: 'DELETE',
    path: '/variables/:id',
    summary: 'Delete a variable',
    tag: 'Variables',
    scope: 'variable:delete',
    access: {
      scope: ['variable:delete', 'projectVariable:delete'],
      target: ({ params }) => ({ variableId: params.id }),
    },
    params: idParams,
    response: 'Ok',
    handler: async (ctx, { auth, params }) => {
      await ctx.variables.delete(auth, params.id);
      return { data: { ok: true } };
    },
  },
  ...PUBLIC_FOLDER_ROUTES,
  ...PUBLIC_DATA_TABLE_ROUTES,
  ...PUBLIC_EVALUATION_ROUTES,
  ...PUBLIC_PROJECT_ROUTES,
  ...PUBLIC_ROLE_ROUTES,
  ...PUBLIC_SECURITY_POLICY_ROUTES,
  // P6 S2: users (P6-21), role mapping rules (P6-11), LDAP (P6-12), SSO config (P6-14)
  ...PUBLIC_USER_ROUTES,
  ...PUBLIC_ROLE_MAPPING_ROUTES,
  ...PUBLIC_LDAP_ROUTES,
  ...PUBLIC_SSO_ROUTES,
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
  ProjectRef: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { enum: ['personal', 'team'] },
    },
  },
  Project: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { enum: ['personal', 'team'] },
      icon: { type: ['object', 'null'], description: '{ type: icon | emoji, value }' },
      description: { type: ['string', 'null'] },
      role: { type: 'string', description: "The caller's role in the project, when it has one" },
      scopes: { type: 'array', items: { type: 'string' }, description: "The caller's scopes in the project" },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ProjectUser: {
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'uuid' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', description: 'A project role slug, such as project:editor' },
    },
  },
  ProjectUsersResult: {
    type: 'object',
    properties: {
      conflicts: {
        type: 'array',
        description: 'Users who already hold another role in the project',
        items: {
          type: 'object',
          properties: {
            userId: { type: 'string', format: 'uuid' },
            currentRole: { type: 'string' },
            requestedRole: { type: 'string' },
          },
        },
      },
    },
  },
  Role: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: ['string', 'null'] },
      systemRole: { type: 'boolean' },
      roleType: { enum: ['global', 'project', 'workflow', 'credential', 'secretsProviderConnection'] },
      scopes: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  /** P6-21: a member of the workspace (n8n's user fields; `role` with `includeRole=true`) */
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      isPending: { type: 'boolean' },
      role: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      inviteAcceptUrl: { type: 'string', description: 'Only on a new invitation, when mail did not send it' },
      emailSent: { type: 'boolean', description: 'Only on a new invitation' },
    },
  },
  /** P6-14: the SAML or OIDC config (secrets blanked); a GET answer can be sent back as the PUT body */
  SsoConfig: { type: 'object', additionalProperties: true },
  /** P6-12: the LDAP config (the bind password blanked) */
  LdapConfig: { type: 'object', additionalProperties: true },
  /** P6-12: one LDAP sync run */
  LdapSyncRun: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      runMode: { enum: ['live', 'dry'] },
      status: { type: 'string' },
      startedAt: { type: 'string', format: 'date-time' },
      endedAt: { type: ['string', 'null'], format: 'date-time' },
      scanned: { type: 'integer' },
      created: { type: 'integer' },
      updated: { type: 'integer' },
      disabled: { type: 'integer' },
      error: { type: ['string', 'null'] },
    },
  },
  /** P6-11: a role mapping rule; `projectIds` for a project rule */
  RoleMappingRule: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      type: { enum: ['instance', 'project'] },
      expression: { type: 'string' },
      role: { type: 'string' },
      order: { type: 'integer' },
      projectIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  SecurityPolicy: {
    type: 'object',
    properties: {
      personalSpacePublishing: { type: 'boolean' },
      personalSpaceSharing: { type: 'boolean' },
      publishedPersonalWorkflowsCount: { type: 'integer' },
      sharedPersonalWorkflowsCount: { type: 'integer' },
      sharedPersonalCredentialsCount: { type: 'integer' },
    },
  },
  Variable: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      key: { type: 'string' },
      value: { type: 'string' },
      projectId: { type: ['string', 'null'], format: 'uuid', description: 'Null for a global variable' },
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
      isArchived: { type: 'boolean' },
      folderId: { type: ['string', 'null'], format: 'uuid' },
      projectId: { type: 'string', format: 'uuid', description: 'The project that owns it' },
      homeProject: { oneOf: [ref('ProjectRef'), { type: 'null' }] },
      sharedWithProjects: { type: 'array', items: ref('ProjectRef') },
      publishedVersionId: { type: ['string', 'null'], format: 'uuid' },
      tags: { type: 'array', items: ref('TagRef') },
      nodeTypes: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TagRef: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
  NodeGroup: {
    type: 'object',
    required: ['id', 'name', 'nodeIds'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      nodeIds: { type: 'array', items: { type: 'string' } },
      description: { type: 'string', maxLength: 145 },
    },
  },
  Folder: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      parentFolderId: { type: ['string', 'null'], format: 'uuid' },
      projectId: { type: 'string', format: 'uuid', description: 'The project that owns it' },
      homeProject: { oneOf: [ref('ProjectRef'), { type: 'null' }] },
      sharedWithProjects: { type: 'array', items: ref('ProjectRef') },
      tags: { type: 'array', items: ref('TagRef') },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
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
      nodeGroups: { type: 'array', items: ref('NodeGroup') },
      active: { type: 'boolean' },
      versionId: { type: 'string', format: 'uuid' },
      folderId: { type: ['string', 'null'], format: 'uuid' },
      isArchived: { type: 'boolean' },
      projectId: { type: 'string', format: 'uuid', description: 'The project that owns it' },
      homeProject: { oneOf: [ref('ProjectRef'), { type: 'null' }] },
      sharedWithProjects: { type: 'array', items: ref('ProjectRef') },
      scopes: {
        type: 'array',
        items: { type: 'string' },
        description: "The caller's scopes on the workflow",
      },
      publishedVersionId: { type: ['string', 'null'], format: 'uuid' },
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
  DataTableColumn: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      type: { enum: ['string', 'number', 'boolean', 'date'] },
      index: { type: 'integer' },
    },
  },
  DataTable: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      projectId: { type: 'string', format: 'uuid', description: 'The project that owns it' },
      columns: { type: 'array', items: ref('DataTableColumn') },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  DataTableRow: {
    type: 'object',
    description: 'The system columns, and one property per column of the table',
    properties: {
      id: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: true,
  },
  DataTableDependency: {
    type: 'object',
    properties: {
      type: { const: 'workflow' },
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
    },
  },
  DataTableResult: {
    description: 'What a write answers: true, a count, ids or rows, as the request asked',
  },
  /** P5-12: the fields of TestRunDto (workflow/src/evaluation.ts) */
  TestRun: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      workflowId: { type: 'string', format: 'uuid' },
      status: { enum: ['new', 'running', 'completed', 'error', 'cancelled'] },
      runAt: { type: ['string', 'null'], format: 'date-time' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
      metrics: {
        type: ['object', 'null'],
        description:
          'The mean of each metric over the cases that have it (failed cases still add the predefined metrics)',
        additionalProperties: { type: 'number' },
      },
      errorCode: { type: ['string', 'null'] },
      errorDetails: { type: ['object', 'null'] },
      concurrency: { type: 'integer', minimum: 1, maximum: 10 },
      finalResult: { enum: ['success', 'error', null] },
      caseCounts: {
        type: 'object',
        description: 'The number of test cases per status, and their total',
        properties: {
          new: { type: 'integer' },
          running: { type: 'integer' },
          success: { type: 'integer' },
          error: { type: 'integer' },
          cancelled: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  /** P5-12: the fields of TestCaseDto (workflow/src/evaluation.ts) */
  TestCase: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      testRunId: { type: 'string', format: 'uuid' },
      executionId: { type: ['string', 'null'], format: 'uuid' },
      status: { enum: ['new', 'running', 'success', 'error', 'cancelled'] },
      runIndex: { type: 'integer', description: 'The index of the dataset row the case ran' },
      runAt: { type: ['string', 'null'], format: 'date-time' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
      errorCode: { type: ['string', 'null'] },
      errorDetails: { type: ['object', 'null'] },
      metrics: { type: ['object', 'null'], additionalProperties: { type: 'number' } },
      inputs: { type: ['object', 'null'] },
      outputs: { type: ['object', 'null'] },
    },
  },
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
        [route.status ?? 200]: {
          description: route.status === 201 ? 'Created' : route.status === 202 ? 'Accepted' : 'OK',
          content: { 'application/json': { schema: success } },
        },
        400: errorResponse('Invalid request'),
        401: errorResponse('Missing or invalid API key'),
        403: errorResponse('Missing a scope required to perform this action'),
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
        'Manage workflows, executions, credentials, tags, variables, projects, roles, users and sign-in settings of one workspace. A key sees and changes only what its user may: the user scopes in each project and the key scopes both apply. Authenticate with an API key in the X-API-KEY header. Lists use cursor pagination: pass `nextCursor` as `cursor`.',
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** what a row asks of the caller, for the reference page: the user's scope(s), or the key scope */
function accessLabel(access: RouteAccess, keyScope: ApiKeyScope | undefined): string {
  if ('open' in access) return keyScope ?? 'any key';
  return ([] as string[]).concat(access.scope as string | string[]).join(' or ');
}

/** A readable, script-free reference of the public API (rendered from the route table). */
export function renderApiDocs(ctx: ServerContext): string {
  const brand = escapeHtml(ctx.config.brand.name);
  const base = escapeHtml(`${ctx.config.baseUrl}/api/v1`);
  const groups = [...new Set(PUBLIC_ROUTES.map((r) => r.tag))];
  const describe = (schema: z.ZodType | undefined) => {
    if (!schema) return '';
    const json = toJsonSchema(schema) as {
      properties?: Record<string, { type?: unknown }>;
      required?: string[];
    };
    const fields = Object.entries(json.properties ?? {}).map(([name, s]) => {
      const type = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any');
      const required = (json.required ?? []).includes(name) ? '' : '?';
      return `<code>${escapeHtml(name)}${required}: ${escapeHtml(String(type))}</code>`;
    });
    return fields.join(' ');
  };
  const sections = groups
    .map((group) => {
      const rows = PUBLIC_ROUTES.filter((r) => r.tag === group)
        .map(
          (r) => `<li class="op">
  <div class="sig"><span class="m m-${r.method.toLowerCase()}">${r.method}</span><code class="path">${escapeHtml(r.path)}</code><span class="role">${escapeHtml(accessLabel(r.access, r.scope))}</span></div>
  <p>${escapeHtml(r.summary)}</p>
  ${r.query ? `<p class="fields"><span>Query</span> ${describe(r.query)}</p>` : ''}
  ${r.body ? `<p class="fields"><span>Body</span> ${describe(r.body)}</p>` : ''}
</li>`,
        )
        .join('\n');
      return `<section><h2>${escapeHtml(group)}</h2><ul>${rows}</ul></section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} API reference</title>
<style>
:root{--bg:#fafafa;--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--card:#fff;--get:#0369a1;--post:#15803d;--put:#a16207;--delete:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--card:#18181b;--get:#38bdf8;--post:#4ade80;--put:#facc15;--delete:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0}h2{font-size:1.1rem;margin:32px 0 8px}
.lead{color:var(--muted)}ul{list-style:none;padding:0;margin:0}.op{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
.op p{margin:6px 0 0;color:var(--muted)}.sig{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.path{font-weight:600;overflow-wrap:anywhere}
.m{font:600 12px/1 ui-monospace,monospace;padding:4px 6px;border-radius:4px;border:1px solid currentColor;min-width:56px;text-align:center}
.m-get{color:var(--get)}.m-post{color:var(--post)}.m-put{color:var(--put)}.m-delete{color:var(--delete)}
.role{margin-left:auto;font-size:12px;color:var(--muted)}.fields span{font-weight:600;color:var(--fg);margin-right:4px}
code{font-family:ui-monospace,monospace;font-size:13px}.fields code{margin-right:8px}a{color:var(--get)}
</style></head><body><main>
<h1>${brand} API reference</h1>
<p class="lead">Base URL <code>${base}</code>. Send an API key (Settings, API keys) in the <code>X-API-KEY</code> header. Responses are <code>{ "data": ... }</code>; lists add <code>nextCursor</code>, errors are <code>{ "error": { "code", "message" } }</code>. Machine-readable: <a href="openapi.json">openapi.json</a> (OpenAPI 3.1).</p>
${sections}
</main></body></html>`;
}

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The access check of one call, before the schemas run (so a refused caller gets 403, not 400). Returns the
 * project of a `create` row. `requireScope` reads the signed-in key's user: scopes of its workspace role plus
 * its project roles, on the target, with another workspace's id as 404.
 */
async function checkAccess(
  ctx: ServerContext,
  request: FastifyRequest,
  access: RouteAccess,
  params: unknown,
): Promise<string | undefined> {
  if ('open' in access) return undefined;
  const auth = request.auth!;
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (access.create) {
    const projectId = await ctx.access.targetProject(auth, stringOf(body.projectId) ?? null);
    await requireScope(request, access.scope, { projectId });
    return projectId;
  }
  const target = access.target?.({
    params,
    query: request.query ?? {},
    body: typeof request.body === 'object' && request.body !== null ? body : {},
  });
  if (access.list && !target) return undefined;
  await requireScope(request, access.scope, target);
  return undefined;
}

export async function publicApiPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  let document: Record<string, unknown> | undefined;
  app.get('/openapi.json', async () => {
    document ??= buildOpenApiDocument(ctx);
    return document;
  });
  let docs: string | undefined;
  app.get('/docs', async (_request, reply) => {
    docs ??= renderApiDocs(ctx);
    return reply.header('content-type', 'text/html; charset=utf-8').send(docs);
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
      handler: async (request, reply) => {
        await loadApiKey(request, ctx.auth);
        const auth = request.auth!;
        // the key's own scope first (a key that lacks it learns nothing about any row), then the user's
        // scopes on the row (403 before any body check); an id that is no uuid is a 400 for every caller
        assertApiKeyScope(auth, route.scope);
        const params = route.params ? parse(route.params, request.params) : {};
        const projectId = await checkAccess(ctx, request, route.access, params);
        const input: PublicApiInput = {
          auth,
          request,
          projectId,
          params,
          query: route.query ? parse(route.query, request.query) : {},
          body: route.body ? parse(route.body, request.body ?? {}) : undefined,
        };
        const result = await route.handler(ctx, input);
        if (route.status) reply.status(route.status);
        return result;
      },
    });
  }
}
