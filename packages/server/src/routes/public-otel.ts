/**
 * Public API OpenTelemetry settings (P6-67, L11): GET and PUT `/settings/otel` and POST `/settings/otel/test-trace`,
 * all `otel:manage` (user scope and key scope), through `ctx.otelSettings` as REST; header values blank on read.
 * PUBLIC_OTEL_ROUTES is shaped as PUBLIC_SOURCE_CONTROL_ROUTES (public-api.ts spreads it).
 * The rows and gates are final; the handlers are the REST ones (same service, same rules).
 */
import { otelSettingsBodySchema } from './otel';
import type { ApiRoute } from './public-api';

const TAG = 'OpenTelemetry';

export const PUBLIC_OTEL_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/settings/otel',
    summary: 'Get the OpenTelemetry settings (header values blank)',
    tag: TAG,
    access: { scope: 'otel:manage' },
    scope: 'otel:manage',
    response: 'OtelSettings',
    handler: async (ctx, { auth }) => ({ data: await ctx.otelSettings.read(auth) }),
  },
  {
    method: 'PUT',
    path: '/settings/otel',
    summary: 'Replace the OpenTelemetry settings',
    tag: TAG,
    access: { scope: 'otel:manage' },
    scope: 'otel:manage',
    body: otelSettingsBodySchema,
    response: 'OtelSettings',
    handler: async (ctx, { auth, body }) => ({ data: await ctx.otelSettings.replace(auth, body) }),
  },
  {
    method: 'POST',
    path: '/settings/otel/test-trace',
    summary: 'Send a test trace with the given settings (not saved)',
    tag: TAG,
    access: { scope: 'otel:manage' },
    scope: 'otel:manage',
    body: otelSettingsBodySchema,
    response: 'OtelTestTraceResult',
    handler: async (ctx, { auth, body }) => ({ data: await ctx.otelSettings.testTrace(auth, body) }),
  },
];
