/**
 * Node parameter options (`POST /rest/node-types/options`): a node type's `loadOptions`, `listSearch`
 * or `resourceMapping` method run for one tenant. Moved out of routes/settings.ts (P5 S5, C0e) with no
 * change, so the route and the Assistant's `get_node_parameter_options` (L6) share one path.
 *
 * P6-27: the access check and the project binding live here, so no caller can skip them. The body names
 * `workflowId` (the caller needs `workflow:update` on it; its project is the run's project) or, for a
 * workflow not saved yet, `projectId` (`workflow:create` in it); a body with neither is refused with 400.
 * The method's services (credentials, data
 * tables, variables) are bound to that project, and the workflow pickers list through the caller's access
 * filter. This function parses the body itself.
 */
import { createBaseContext } from '@workflow/core';
import {
  ExpressionEvaluator,
  type LoadOptionsContext,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor } from '../http/pagination';
import { nodeSchema } from '../http/schemas';
import { isUuid } from '../repositories/util';
import { MISSING_SCOPE_MESSAGE } from './access';

export const nodeOptionsSchema = z.object({
  nodeType: z.string().min(1),
  method: z.string().min(1),
  kind: z.enum(['loadOptions', 'listSearch', 'resourceMapping']),
  node: nodeSchema,
  filter: z.string().max(1000).optional(),
  paginationToken: z.string().max(2000).optional(),
  /** the workflow open in the editor (left out of workflow pickers); its project is the project of the run */
  workflowId: z.string().uuid().optional(),
  /** for a workflow not saved yet: the project it will be created in */
  projectId: z.string().uuid().optional(),
});

export type NodeOptionsBody = z.infer<typeof nodeOptionsSchema>;

const WORKFLOW_PAGE_SIZE = 50;

const isIsoDate = (value: string) => {
  const time = new Date(value).getTime();
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
};

/** a workflow cursor is [updatedAt, id]: both reach the query, so both must be what the query expects */
function decodeWorkflowCursor(token: string | undefined) {
  const cursor = decodeCursor(token);
  if (cursor && (!isIsoDate(cursor.value) || !isUuid(cursor.id))) {
    throw ApiError.badRequest('Invalid cursor');
  }
  return cursor;
}

/** what the caller named, read before the body is parsed so a caller without the scope is 403 first */
const optionsTarget = z.object({ workflowId: z.string().optional(), projectId: z.string().optional() });

/**
 * The project the method runs in, after the scope check: `workflow:update` on `workflowId`, else
 * `workflow:create` in `projectId`. A caller who named neither is refused with 400 (decisions.md, node
 * options: one of the two is required). Another workspace's id, a missing or malformed id is 404.
 */
async function projectOfOptions(ctx: ServerContext, auth: AuthContext, rawBody: unknown): Promise<string> {
  const { access, repos } = ctx;
  const named = optionsTarget.safeParse(rawBody);
  const { workflowId, projectId } = named.success ? named.data : {};
  if (workflowId !== undefined) {
    const held = await access.scopesForAuth(auth, { workflowId });
    if (!held.has('workflow:update')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const row = await repos.workflows.get(auth.tenant.id, workflowId);
    if (!row) throw ApiError.notFound('Workflow not found');
    return row.projectId;
  }
  if (projectId !== undefined) {
    const held = await access.scopesForAuth(auth, { projectId });
    if (!held.has('workflow:create')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    return projectId;
  }
  throw ApiError.badRequest("Couldn't load the options: the request names no workflowId and no projectId");
}

/**
 * Runs the method `body` names and returns its result (the route answers `{ data: result }`).
 * The caller's scope is checked first (see the top of this file), then `body` is parsed with
 * `nodeOptionsSchema` (400 on a bad body); an unknown node type or method is a
 * 400, and an error thrown by the method is a 400 `options_error` with its message.
 */
export async function loadNodeOptions(
  ctx: ServerContext,
  auth: AuthContext,
  rawBody: unknown,
): Promise<unknown> {
  const { repos, registries } = ctx;
  const projectId = await projectOfOptions(ctx, auth, rawBody);
  const body = parse(nodeOptionsSchema, rawBody);
  const type = registries.nodeTypes.get(body.nodeType);
  if (!type) throw ApiError.badRequest(`Unknown node type "${body.nodeType}"`);
  // own entries only: `constructor` must not reach Object() with the context
  const methods = type.methods?.[body.kind];
  const method = methods && Object.hasOwn(methods, body.method) ? methods[body.method] : undefined;
  if (!method)
    throw ApiError.badRequest(`Node type "${body.nodeType}" has no ${body.kind} method "${body.method}"`);
  const node = { ...body.node, type: body.nodeType } as WorkflowNode;
  const workflow = new Workflow(
    { id: body.workflowId, name: 'options', nodes: [node], connections: {} },
    registries.nodeTypes,
  );
  const services = await ctx.executions.buildServices({
    tenant: auth.tenant,
    executionId: '',
    projectId,
    mode: 'manual',
  });
  const base = createBaseContext({
    workflow,
    node,
    services,
    evaluator: new ExpressionEvaluator({ timeoutMs: 1000 }),
    signal: AbortSignal.timeout(30_000),
  });
  const { getNodeParameter, ...rest } = base;
  const loadCtx: LoadOptionsContext = {
    ...rest,
    getCurrentNodeParameter: (name: string) => {
      try {
        return getNodeParameter(name, 0, undefined);
      } catch {
        return undefined;
      }
    },
    listWorkflows: async ({ filter, paginationToken, excludeId }) => {
      // one row more than a page tells whether another page follows; one more again covers the excluded row
      const rows = await repos.workflows.list(auth.tenant.id, {
        filter: await ctx.access.listFilter(auth, 'workflow:list'),
        search: filter,
        limit: WORKFLOW_PAGE_SIZE + (excludeId ? 1 : 0),
        cursor: decodeWorkflowCursor(paginationToken),
      });
      const visible = rows.filter((row) => row.id !== excludeId);
      const page = visible.slice(0, WORKFLOW_PAGE_SIZE);
      const last = page[page.length - 1];
      return {
        workflows: page.map((row) => ({ id: row.id, name: row.name })),
        paginationToken:
          visible.length > WORKFLOW_PAGE_SIZE && last ? encodeCursor(last.updatedAt, last.id) : undefined,
      };
    },
    readWorkflow: async (id) => {
      const row = await repos.workflows.get(auth.tenant.id, id);
      if (!row) return undefined;
      // a workflow the caller cannot read looks like a missing one
      const readable = await ctx.access.listFilter(auth, 'workflow:read');
      if (
        !readable.all &&
        !readable.projectIds.includes(row.projectId) &&
        !readable.workflowIds.includes(row.id)
      ) {
        return undefined;
      }
      return {
        id: row.id,
        name: row.name,
        nodes: row.nodes as WorkflowDefinition['nodes'],
        connections: row.connections as WorkflowDefinition['connections'],
        settings: row.settings as WorkflowDefinition['settings'],
      };
    },
  };
  try {
    return body.kind === 'listSearch'
      ? await (method as (c: LoadOptionsContext, f?: string, t?: string) => Promise<unknown>)(
          loadCtx,
          body.filter,
          body.paginationToken,
        )
      : await (method as (c: LoadOptionsContext) => Promise<unknown>)(loadCtx);
  } catch (error) {
    throw new ApiError(400, 'options_error', (error as Error).message);
  }
}
