/**
 * Public API evaluation test runs (P5-12), n8n's public evaluations controller: 5 routes with the
 * `testRun:*` API key scopes. PUBLIC_EVALUATION_ROUTES is final and carries everything a PUBLIC_ROUTES
 * row needs (public-api.ts spreads it and runs the `access` check, then the key scope). As n8n's test-runs
 * controller, `testRun:*` is only the key scope: the user needs `workflow:read` (list, get, cases) or
 * `workflow:execute` (start, cancel) on the workflow. The handlers call
 * `ctx.evaluations`; lists answer `{data, nextCursor}` with the cursor helpers of public-data-tables.ts.
 * Create answers 201 (409 `Workflow has no evaluation trigger`; no 402, there is no licence gate).
 */
import { MAX_EVALUATION_CONCURRENCY, MAX_EVALUATION_ROWS } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ApiKeyScope } from '../http/api-key-scopes';
import { ApiError } from '../http/errors';
import type { PublicApiInput, RouteAccess, RouteTarget } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

export type PublicEvaluationHandler = 'list' | 'create' | 'get' | 'listCases' | 'cancel';

export interface PublicEvaluationRoute {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  tag: 'Evaluations';
  /** who may call it, by the user's workflow scope; the key must hold `scope` (`testRun:*`) as well */
  access: RouteAccess;
  scope: ApiKeyScope;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** component schema name of `data` in the response */
  response: 'TestRun' | 'TestCase' | 'Ok';
  list?: boolean;
  /** the success status when it is not 200 */
  status?: 201;
  handler: Handler;
}

const workflowParams = z.object({ workflowId: z.uuid() });
const runParams = z.object({ workflowId: z.uuid(), runId: z.uuid() });
const listQuery = z.object({
  status: z.enum(['new', 'running', 'completed', 'error', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const casesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const createBody = z.object({
  concurrency: z.number().int().min(1).max(MAX_EVALUATION_CONCURRENCY).optional(),
  rowIndices: z.array(z.number().int().min(0)).max(MAX_EVALUATION_ROWS).optional(),
});

/** the cursor is an opaque offset: `o` and the number of rows already sent (as public-data-tables.ts) */
const CURSOR_PREFIX = 'o';

function decodeCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const skip = text.startsWith(CURSOR_PREFIX) ? Number(text.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    Buffer.from(raw, 'base64url').toString('base64url') !== raw
  ) {
    throw ApiError.badRequest('Invalid cursor');
  }
  return skip;
}

const encodeCursor = (skip: number) => Buffer.from(`${CURSOR_PREFIX}${skip}`, 'utf8').toString('base64url');

/** one page of `{count, data}` as `{data, nextCursor}` */
function paged<T>(page: { count: number; data: T[] }, skip: number) {
  const end = skip + page.data.length;
  return {
    data: page.data,
    nextCursor: page.data.length > 0 && end < page.count ? encodeCursor(end) : null,
  };
}

const actorOf = ({ auth, request }: PublicApiInput) => ({ userId: auth.user.id, ip: request.ip });

/** the handlers; the rows below bind to them late, so the handler that runs is the one here */
export const publicEvaluationHandlers: Record<PublicEvaluationHandler, Handler> = {
  list: async (ctx, { auth, params, query }) => {
    const skip = decodeCursor(query.cursor);
    const page = await ctx.evaluations.list(auth.tenant.id, params.workflowId, {
      skip,
      limit: query.limit,
      status: query.status,
    });
    return paged(page, skip);
  },
  create: async (ctx, input) => {
    const { auth, params, body } = input;
    const { testRunId } = await ctx.evaluations.start(
      auth.tenant,
      params.workflowId,
      { concurrency: body?.concurrency, rowIndices: body?.rowIndices },
      actorOf(input),
    );
    return { data: await ctx.evaluations.get(auth.tenant.id, params.workflowId, testRunId) };
  },
  get: async (ctx, { auth, params }) => ({
    data: await ctx.evaluations.get(auth.tenant.id, params.workflowId, params.runId),
  }),
  listCases: async (ctx, { auth, params, query }) => {
    const skip = decodeCursor(query.cursor);
    const page = await ctx.evaluations.listCases(auth.tenant.id, params.workflowId, params.runId, {
      skip,
      limit: query.limit,
    });
    return paged(page, skip);
  },
  cancel: async (ctx, { auth, params }) => {
    await ctx.evaluations.cancel(auth.tenant.id, params.workflowId, params.runId);
    return { data: { ok: true } };
  },
};

const route = (
  name: PublicEvaluationHandler,
  row: Omit<PublicEvaluationRoute, 'tag' | 'handler'>,
): PublicEvaluationRoute => ({
  ...row,
  tag: 'Evaluations',
  handler: (ctx, input) => publicEvaluationHandlers[name](ctx, input),
});

const onWorkflow: RouteTarget = ({ params }) => ({ workflowId: params.workflowId });

const runs = '/workflows/:workflowId/test-runs';
const one = `${runs}/:runId`;

export const PUBLIC_EVALUATION_ROUTES: PublicEvaluationRoute[] = [
  route('list', {
    method: 'GET',
    path: runs,
    summary: 'List the test runs of a workflow',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'testRun:list',
    params: workflowParams,
    query: listQuery,
    response: 'TestRun',
    list: true,
  }),
  route('create', {
    method: 'POST',
    path: runs,
    summary: 'Start a test run of the workflow (one case per row of its Evaluation Trigger)',
    access: { scope: 'workflow:execute', target: onWorkflow },
    scope: 'testRun:create',
    params: workflowParams,
    body: createBody,
    response: 'TestRun',
    status: 201,
  }),
  route('get', {
    method: 'GET',
    path: one,
    summary: 'Get a test run',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'testRun:read',
    params: runParams,
    response: 'TestRun',
  }),
  route('listCases', {
    method: 'GET',
    path: `${one}/test-cases`,
    summary: 'List the test cases of a test run',
    access: { scope: 'workflow:read', target: onWorkflow },
    scope: 'testRun:read',
    params: runParams,
    query: casesQuery,
    response: 'TestCase',
    list: true,
  }),
  route('cancel', {
    method: 'POST',
    path: `${one}/cancel`,
    summary: 'Cancel a test run',
    access: { scope: 'workflow:execute', target: onWorkflow },
    scope: 'testRun:cancel',
    params: runParams,
    response: 'Ok',
  }),
];
