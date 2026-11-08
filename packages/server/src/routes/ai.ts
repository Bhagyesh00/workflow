/**
 * /rest/ai (P5-09, L1): POST `/ai/build` (editor; NDJSON stream `application/x-ndjson` through
 * `reply.hijack()` as routes/push.ts, one `BuilderChunk` per line, aborted on client close and at
 * `AI_TIMEOUT_MAX`) and POST `/ai/usage-settings` (admin; writes `allowSendingParameterValues`).
 * Gates and rate limit are final from C0: `AI_ENABLED` false gives 404, then the role; 100 per IP.
 * Nothing about the prompt or the body is logged.
 */
import {
  BUILDER_PROMPT_LIMIT,
  BUILDER_PROMPT_TOO_LONG,
  type BuilderChunk,
  type BuildRequest,
  redactSecrets,
} from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { workflowDataSchema } from '../http/schemas';
import type { TenantSettings } from '../plans';
import { BUILDER_ERROR_TITLE } from '../services/ai-builder/builder';
import { NO_MODEL_SET } from '../services/ai-builder/model';
import { AI_ROUTE_RATE_LIMIT } from '../services/ai-builder/types';

/** the gate of every `/rest/ai/*` route: 404 while `AI_ENABLED` is false, then `requireRole` */
export function requireAiBuilder(request: FastifyRequest, ctx: ServerContext, minimum: Role): AuthContext {
  if (!ctx.config.ai.enabled) throw ApiError.notFound();
  return requireRole(request, minimum);
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
    const auth = requireAiBuilder(request, ctx, 'editor');
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
    const auth = requireAiBuilder(request, ctx, 'admin');
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
