/**
 * /rest/otel (P6-67, L11): GET and PUT `/otel/settings` and POST `/otel/test-trace`, all `otel:manage`. Header values
 * are blank in every answer (`name=`); a blank value on PUT keeps the stored one only while the endpoint's scheme,
 * host and port are unchanged.
 * The gates are `requireScope('otel:manage')`; the handlers reach `ctx.otelSettings` (services/tracing/settings.ts), which
 * checks the endpoint, the headers and the kept values, and answers header values blank.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

/** n8n's OpenTelemetry settings fields (a full replacement; the endpoint and header rules are the service's) */
export const otelSettingsBodySchema = z.object({
  enabled: z.boolean(),
  exporterProtocol: z.enum(['http/protobuf', 'grpc']),
  exporterEndpoint: z.string().trim().max(2048),
  exporterTracingPath: z.string().trim().max(512),
  exporterServiceName: z.string().trim().min(1).max(255),
  exporterHeaders: z.string().max(8192),
  tracesSampleRate: z.number().min(0).max(1),
  startupConnectivityTimeoutMs: z.number().int().min(0).max(60_000),
  includeNodeSpans: z.boolean(),
  emitWorkflowStartSpan: z.boolean(),
  emitNodeStartSpan: z.boolean(),
  injectOutbound: z.boolean(),
  productionExecutionsOnly: z.boolean(),
});

export function registerOtelRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/otel/settings', async (request) => {
    const auth = await requireScope(request, 'otel:manage');
    return { data: await ctx.otelSettings.read(auth) };
  });

  app.put('/otel/settings', async (request) => {
    const auth = await requireScope(request, 'otel:manage');
    const body = parse(otelSettingsBodySchema, request.body ?? {});
    return { data: await ctx.otelSettings.replace(auth, body) };
  });

  app.post('/otel/test-trace', async (request) => {
    const auth = await requireScope(request, 'otel:manage');
    const body = parse(otelSettingsBodySchema, request.body ?? {});
    return { data: await ctx.otelSettings.testTrace(auth, body) };
  });
}
