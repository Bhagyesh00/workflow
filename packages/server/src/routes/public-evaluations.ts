/**
 * Public API evaluation test runs (P5-12), n8n's public evaluations controller: 5 routes with the
 * `testRun:*` API key scopes. PUBLIC_EVALUATION_ROUTES is final and carries everything a PUBLIC_ROUTES
 * row needs (public-api.ts spreads it; the role and scope gates run there). The handlers call
 * `ctx.evaluations`; lists answer `{data, nextCursor}` with the cursor helpers of public-data-tables.ts.
 * Create answers 201 (409 `Workflow has no evaluation trigger`; no 402, there is no licence gate).
 *
 * C0 STUB: lane L10 writes the handlers in `publicEvaluationHandlers` (every body throws
 * `not implemented (L10)`); the rows are final.
 */
import { MAX_EVALUATION_CONCURRENCY, MAX_EVALUATION_ROWS } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import type { ApiKeyScope } from '../http/api-key-scopes';
import type { PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

export type PublicEvaluationHandler = 'list' | 'create' | 'get' | 'listCases' | 'cancel';

export interface PublicEvaluationRoute {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  tag: 'Evaluations';
  role: Role;
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

const notImplemented = (): Promise<unknown> => Promise.reject(new Error('not implemented (L10)'));

/** L10 fills these; the rows below bind to them late, so the handler that runs is the one here */
export const publicEvaluationHandlers: Record<PublicEvaluationHandler, Handler> = {
  list: () => notImplemented(),
  create: () => notImplemented(),
  get: () => notImplemented(),
  listCases: () => notImplemented(),
  cancel: () => notImplemented(),
};

const route = (
  name: PublicEvaluationHandler,
  row: Omit<PublicEvaluationRoute, 'tag' | 'handler'>,
): PublicEvaluationRoute => ({
  ...row,
  tag: 'Evaluations',
  handler: (ctx, input) => publicEvaluationHandlers[name](ctx, input),
});

const runs = '/workflows/:workflowId/test-runs';
const one = `${runs}/:runId`;

export const PUBLIC_EVALUATION_ROUTES: PublicEvaluationRoute[] = [
  route('list', {
    method: 'GET',
    path: runs,
    summary: 'List the test runs of a workflow',
    role: 'viewer',
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
    role: 'editor',
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
    role: 'viewer',
    scope: 'testRun:read',
    params: runParams,
    response: 'TestRun',
  }),
  route('listCases', {
    method: 'GET',
    path: `${one}/test-cases`,
    summary: 'List the test cases of a test run',
    role: 'viewer',
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
    role: 'editor',
    scope: 'testRun:cancel',
    params: runParams,
    response: 'Ok',
  }),
];
