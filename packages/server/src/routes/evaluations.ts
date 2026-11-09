/**
 * /rest/workflows/:workflowId/test-runs (P5-02), n8n's test-runs controller (P6-38): reads need
 * `workflow:read`, runs, cancels and deletes `workflow:execute`, both on the workflow named in the path.
 * A caller who cannot read the workflow gets 404 (its existence stays hidden, as n8n's workflow lookup);
 * a reader without `workflow:execute` gets 403. A run of another workflow or tenant answers 404, like
 * one that does not exist.
 *
 * The two list routes answer the page's rows as a plain array, the shape the editor's `evaluationsApi`
 * reads (`TestRunDto[]`, `TestCaseDto[]`, paged with `skip` and `limit`); the public API keeps the count.
 */
import { MAX_EVALUATION_CONCURRENCY, MAX_EVALUATION_ROWS } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import type { EvaluationService } from '../services/evaluations';

export const TEST_RUN_STATUSES = ['new', 'running', 'completed', 'error', 'cancelled'] as const;

export const testRunWorkflowParams = z.object({ workflowId: z.uuid() });
export const testRunParams = z.object({ workflowId: z.uuid(), id: z.uuid() });
export const testCaseParams = z.object({ workflowId: z.uuid(), id: z.uuid(), caseId: z.uuid() });

/** n8n's `POST test-runs/new` body without the config-based fields */
export const testRunStartBody = z.object({
  concurrency: z.number().int().min(1).max(MAX_EVALUATION_CONCURRENCY).optional(),
  rowIndices: z.array(z.number().int().min(0)).max(MAX_EVALUATION_ROWS).optional(),
});

export const testRunListQuery = z.object({
  status: z.enum(TEST_RUN_STATUSES).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(250).default(50),
});

export const testCaseListQuery = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export function registerEvaluationRoutes(
  app: FastifyInstance,
  deps: { evaluations: EvaluationService },
): void {
  const { evaluations } = deps;
  const actor = (request: FastifyRequest) => ({ userId: request.auth?.user.id, ip: request.ip });
  const base = '/workflows/:workflowId/test-runs';
  /** the gate of every route: 404 unless the caller can read the workflow, then `scope` on it (403) */
  const gate = async (
    request: FastifyRequest,
    scope: 'workflow:read' | 'workflow:execute',
    workflowId: string,
  ) => {
    const target = { workflowId };
    try {
      await requireScope(request, 'workflow:read', target);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) throw ApiError.notFound('Workflow');
      throw error;
    }
    return requireScope(request, scope, target);
  };

  app.get(base, async (request) => {
    const { workflowId } = parse(testRunWorkflowParams, request.params);
    const auth = await gate(request, 'workflow:read', workflowId);
    const query = parse(testRunListQuery, request.query);
    return { data: (await evaluations.list(auth.tenant.id, workflowId, query)).data };
  });

  app.post(`${base}/new`, async (request, reply) => {
    const { workflowId } = parse(testRunWorkflowParams, request.params);
    const auth = await gate(request, 'workflow:execute', workflowId);
    const body = parse(testRunStartBody, request.body ?? {});
    const started = await evaluations.start(auth.tenant, workflowId, body, actor(request));
    return reply.status(202).send({ data: started });
  });

  app.get(`${base}/:id`, async (request) => {
    const { workflowId, id } = parse(testRunParams, request.params);
    const auth = await gate(request, 'workflow:read', workflowId);
    return { data: await evaluations.get(auth.tenant.id, workflowId, id) };
  });

  app.get(`${base}/:id/test-cases`, async (request) => {
    const { workflowId, id } = parse(testRunParams, request.params);
    const auth = await gate(request, 'workflow:read', workflowId);
    const query = parse(testCaseListQuery, request.query);
    return { data: (await evaluations.listCases(auth.tenant.id, workflowId, id, query)).data };
  });

  app.delete(`${base}/:id`, async (request) => {
    const { workflowId, id } = parse(testRunParams, request.params);
    const auth = await gate(request, 'workflow:execute', workflowId);
    await evaluations.delete(auth.tenant.id, workflowId, id);
    return { data: { ok: true } };
  });

  app.post(`${base}/:id/cancel`, async (request, reply) => {
    const { workflowId, id } = parse(testRunParams, request.params);
    const auth = await gate(request, 'workflow:execute', workflowId);
    await evaluations.cancel(auth.tenant.id, workflowId, id);
    return reply.status(202).send({ data: { ok: true } });
  });

  app.post(`${base}/:id/test-cases/:caseId/cancel`, async (request) => {
    const { workflowId, id, caseId } = parse(testCaseParams, request.params);
    const auth = await gate(request, 'workflow:execute', workflowId);
    await evaluations.cancelCase(auth.tenant.id, workflowId, id, caseId);
    return { data: { ok: true } };
  });
}
