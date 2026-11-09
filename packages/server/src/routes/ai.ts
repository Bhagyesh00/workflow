/**
 * /rest/ai (P5-09, L1; P6-36): POST `/ai/build` (`workflow:update` on the workflow; NDJSON stream `application/x-ndjson` through
 * `reply.hijack()` as routes/push.ts, one `BuilderChunk` per line, aborted on client close and at
 * `AI_TIMEOUT_MAX`) and POST `/ai/usage-settings` (`aiAssistant:manage`;
 * writes `allowSendingParameterValues`). `AI_ENABLED` false gives 404, then the scope; 100 per IP.
 * Deviation on purpose: n8n puts no scope on the builder route (its ai.controller has none); here a
 * caller needs the same right as saving the workflow, so a project viewer or a member of another
 * project cannot start a turn on it (403), and another workspace's id is 404. The builder model is a
 * workspace setting (set under `instanceAi:manage`) and loads for every project through its `allow`
 * list (admin-set AI credentials are workspace wide). Nothing about the prompt or the body is logged.
 */
import {
  BUILDER_PROMPT_LIMIT,
  BUILDER_PROMPT_TOO_LONG,
  type BuilderChunk,
  type BuildRequest,
  redactSecrets,
  type Scope,
} from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { workflowDataSchema } from '../http/schemas';
import type { TenantSettings } from '../plans';
import type { AccessTarget } from '../services/access';
import { BUILDER_ERROR_TITLE } from '../services/ai-builder/builder';
import { NO_MODEL_SET } from '../services/ai-builder/model';
import { AI_ROUTE_RATE_LIMIT } from '../services/ai-builder/types';

/**
 * the gate of every `/rest/ai/*` route: 404 while `AI_ENABLED` is false, then `requireScope` on `target`
 * (a workflow id: another workspace's id is 404, a workflow the caller cannot update is 403)
 */
export async function requireAiBuilder(
  request: FastifyRequest,
  ctx: ServerContext,
  scope: Scope,
  target?: AccessTarget,
): Promise<AuthContext> {
  if (!ctx.config.ai.enabled) throw ApiError.notFound();
  return requireScope(request, scope, target);
}

const workflowPeek = z.object({ workflowId: z.string().min(1).max(64) });

/** the workflow id a body names, for the gate that runs before the body is validated */
export function peekWorkflowId(body: unknown): string | undefined {
  const peek = workflowPeek.safeParse(body ?? {});
  return peek.success ? peek.data.workflowId : undefined;
}

/** route options of every `/rest/ai/*` route (rate limit 100 per IP, as n8n's `ipRateLimit`) */
export function aiRouteOptions(name: string) {
  return {
    config: {
      rateLimit: {
        max: AI_ROUTE_RATE_LIMIT.max,
        timeWindow: AI_ROUTE_RATE_LIMIT.timeWindow,
        keyGenerator: (request: FastifyRequest) => `ai:${name}:${request.ip}`,
      },
    },
  };
}

const resumeSchema = z.union([
  z.object({
    answers: z
      .array(z.object({ id: z.string().max(200), answer: z.string().max(BUILDER_PROMPT_LIMIT) }))
      .max(50),
  }),
  z.object({
    planDecision: z.enum(['approve', 'modify', 'reject']),
    feedback: z.string().max(BUILDER_PROMPT_LIMIT).optional(),
  }),
  z.object({
    webFetch: z.object({ url: z.string().max(2048), decision: z.enum(['approve', 'deny']) }),
  }),
]);

/** the prompt length is checked by hand, so its error is n8n's text */
const buildSchema = z.object({
  workflowId: z.string().min(1).max(64),
  text: z.string(),
  workflowData: workflowDataSchema.optional(),
  mode: z.enum(['build', 'plan']).optional(),
  resumeData: resumeSchema.optional(),
});

const usageSettingsSchema = z.object({ allowSendingParameterValues: z.boolean() });

export function registerAiRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/ai/build', aiRouteOptions('build'), async (request, reply) => {
    const peeked = peekWorkflowId(request.body);
    const auth = await requireAiBuilder(
      request,
      ctx,
      'workflow:update',
      peeked ? { workflowId: peeked } : undefined,
    );
    const body = parse(buildSchema, request.body);
    if (body.text.length > BUILDER_PROMPT_LIMIT) throw ApiError.badRequest(BUILDER_PROMPT_TOO_LONG);
    if (!body.text.trim() && !body.resumeData) throw ApiError.badRequest('Write what the workflow should do');
    // another tenant's workflow (or none) is 404 before the stream starts
    const row = await ctx.repos.workflows.get(auth.tenant.id, body.workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    if (body.workflowData?.id !== undefined && body.workflowData.id !== row.id) {
      throw ApiError.badRequest('The workflow data belongs to another workflow');
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    const controller = new AbortController();
    // the client went away before the turn ended: stop the model and the tools
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('The client closed the connection'));
    });
    const write = (chunk: BuilderChunk) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(chunk)}\n`);
    };
    const buildRequest: BuildRequest = {
      workflowId: row.id,
      text: body.text,
      ...(body.workflowData ? { workflowData: body.workflowData } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.resumeData ? { resumeData: body.resumeData } : {}),
    };
    try {
      await ctx.aiBuilder.build(auth, buildRequest, write, controller.signal);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : redactSecrets(error instanceof Error ? error.message : '');
      ctx.logger.warn(
        { tenantId: auth.tenant.id, error: error instanceof Error ? error.name : 'unknown' },
        'AI builder request failed',
      );
      write({ type: 'error', title: BUILDER_ERROR_TITLE, message: message || 'The AI builder failed' });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  rest.post('/ai/usage-settings', aiRouteOptions('usage-settings'), async (request) => {
    const auth = await requireAiBuilder(request, ctx, 'aiAssistant:manage');
    const body = parse(usageSettingsSchema, request.body);
    const tenant = await ctx.repos.tenants.get(auth.tenant.id);
    const settings = ((tenant ?? auth.tenant).settings ?? {}) as TenantSettings;
    if (!settings.ai) throw ApiError.badRequest(NO_MODEL_SET);
    const next: TenantSettings = {
      ...settings,
      ai: { ...settings.ai, allowSendingParameterValues: body.allowSendingParameterValues },
    };
    await ctx.repos.tenants.updateSettings(auth.tenant.id, next as Record<string, unknown>);
    await ctx.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'tenant.settings_updated',
      resourceType: 'tenant',
      resourceId: auth.tenant.id,
      ip: request.ip,
    });
    return { data: { allowSendingParameterValues: body.allowSendingParameterValues } };
  });
}
