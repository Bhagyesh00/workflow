/**
 * /rest/workflow-reviews and /rest/inbox (P3-19, P6-27).
 *
 * Every route scopes by tenant (another tenant's request is 404). Submitting and the reviewer list need
 * `workflow:publish` on the request's workflow (without one in the body, in the workspace); the request
 * routes take any signed-in member and then apply the review read gate (404 unless author, assigned
 * reviewer or administrator of the workflow) and the decision rules (403) in the service, which read the
 * caller's scopes on the request's workflow.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';
import {
  activityQuerySchema,
  inboxQuerySchema,
  type ReviewCaller,
  reviewCommentSchema,
  reviewCreateSchema,
  reviewDecisionSchema,
  reviewListQuerySchema,
  reviewUpdateVersionSchema,
} from '../services/workflow-reviews';

/** a malformed id answers 404 like a missing one */
const reviewParams = z.object({ id: z.string().max(64) });

const eligibleQuery = z.object({ workflowId: z.uuid().optional() });

const workflowTarget = z.object({ workflowId: z.uuid() });

/**
 * `workflow:publish` on the workflow `source` names; a source without a valid workflow id is checked in
 * the workspace (a caller with the scope only there reaches the 400 of the body parse)
 */
function requirePublish(request: FastifyRequest, source: unknown): Promise<AuthContext> {
  const target = workflowTarget.safeParse(source);
  return requireScope(request, 'workflow:publish', target.success ? target.data : undefined);
}

export function registerWorkflowReviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { reviews } = ctx;
  const caller = (auth: AuthContext, request: FastifyRequest): ReviewCaller => ({
    userId: auth.user.id,
    role: auth.role,
    auth,
    ip: request.ip,
  });

  app.get('/workflow-reviews', async (request) => {
    const auth = requireAuth(request);
    return reviews.list(auth.tenant.id, caller(auth, request), parse(reviewListQuerySchema, request.query));
  });

  app.get('/workflow-reviews/eligible-reviewers', async (request) => {
    const auth = await requirePublish(request, request.query);
    const { workflowId } = parse(eligibleQuery, request.query);
    return { data: await reviews.eligibleReviewers(auth.tenant.id, caller(auth, request), workflowId) };
  });

  app.post('/workflow-reviews', async (request) => {
    const auth = await requirePublish(request, request.body);
    const body = parse(reviewCreateSchema, request.body);
    return { data: await reviews.create(auth.tenant.id, body, caller(auth, request)) };
  });

  app.get('/workflow-reviews/:id', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(reviewParams, request.params);
    return { data: await reviews.get(auth.tenant.id, id, caller(auth, request)) };
  });

  app.post('/workflow-reviews/:id/update-version', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(reviewParams, request.params);
    const body = parse(reviewUpdateVersionSchema, request.body);
    return { data: await reviews.updateVersion(auth.tenant.id, id, body, caller(auth, request)) };
  });

  app.post('/workflow-reviews/:id/decision', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(reviewParams, request.params);
    const body = parse(reviewDecisionSchema, request.body);
    return { data: await reviews.decide(auth.tenant.id, id, body, caller(auth, request)) };
  });

  app.get('/workflow-reviews/:id/activity', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(reviewParams, request.params);
    const { cursor } = parse(activityQuerySchema, request.query);
    return reviews.activity(auth.tenant.id, id, caller(auth, request), cursor);
  });

  app.post('/workflow-reviews/:id/comments', async (request) => {
    const auth = requireAuth(request);
    const { id } = parse(reviewParams, request.params);
    const { body } = parse(reviewCommentSchema, request.body);
    return { data: await reviews.comment(auth.tenant.id, id, body, caller(auth, request)) };
  });

  app.get('/inbox', async (request) => {
    const auth = requireAuth(request);
    return reviews.inbox(auth.tenant.id, caller(auth, request), parse(inboxQuerySchema, request.query));
  });

  app.get('/inbox/summary', async (request) => {
    const auth = requireAuth(request);
    return { data: await reviews.inboxSummary(auth.tenant.id, caller(auth, request)) };
  });
}
