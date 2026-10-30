/** /rest/settings, /rest/node-types, /rest/credential-types */
import { createBaseContext } from '@workflow/core';
import {
  type CredentialTypeDescription,
  ExpressionEvaluator,
  type LoadOptionsContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { nodeSchema } from '../http/schemas';
import { currentPeriod, effectiveLimits, PLANS, type TenantSettings } from '../plans';

const settingsPatch = z.object({
  brand: z
    .object({
      name: z.string().trim().max(64).optional(),
      logoUrl: z.union([z.url().max(2048), z.literal('')]).optional(),
      primaryColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/)
        .optional(),
    })
    .optional(),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional(),
});

const optionsSchema = z.object({
  nodeType: z.string().min(1),
  method: z.string().min(1),
  kind: z.enum(['loadOptions', 'listSearch']),
  node: nodeSchema,
  filter: z.string().max(1000).optional(),
  paginationToken: z.string().max(2000).optional(),
});

/** JSON copy without functions (descriptions are data by contract; this enforces it) */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { config, repos, registries } = ctx;

  app.get('/settings', async (request) => {
    const auth = request.auth;
    const tenantSettings = (auth?.tenant.settings ?? {}) as TenantSettings;
    const brand = {
      name: tenantSettings.brand?.name || config.brand.name,
      logoUrl: tenantSettings.brand?.logoUrl ?? config.brand.logoUrl,
      primaryColor: tenantSettings.brand?.primaryColor || config.brand.primaryColor,
    };
    const limits = auth
      ? effectiveLimits(auth.tenant.plan, tenantSettings)
      : (PLANS[config.defaultPlan] ?? PLANS.unlimited);
    const usage = auth ? await repos.usage.get(auth.tenant.id, currentPeriod()) : undefined;
    return {
      data: {
        brand,
        baseUrl: config.baseUrl,
        webhookBaseUrl: auth ? `${config.baseUrl}/webhook/${auth.tenant.slug}` : `${config.baseUrl}/webhook`,
        timezone: tenantSettings.timezone ?? config.defaultTimezone,
        limits,
        features: {
          signup: config.signupEnabled,
          executionsMode: config.executionsMode,
          binaryDataMode: config.binaryData.mode,
          oauth2: true,
          publicApi: true,
          versionHistory: true,
          versionDiff: true,
          workflowValidation: true,
          webhookIdempotency: true,
          ssrfProtection: config.ssrf.enabled,
        },
        ...(usage
          ? { usage: { period: usage.period, executions: usage.executions, executionMs: usage.executionMs } }
          : {}),
      },
    };
  });

  app.patch('/settings', async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(settingsPatch, request.body);
    const current = (auth.tenant.settings ?? {}) as TenantSettings;
    const next: TenantSettings = {
      ...current,
      ...(body.brand ? { brand: { ...(current.brand ?? {}), ...body.brand } } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
    };
    const tenant = await repos.tenants.updateSettings(auth.tenant.id, next as Record<string, unknown>);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'tenant.settings_updated',
      resourceType: 'tenant',
      resourceId: auth.tenant.id,
      ip: request.ip,
    });
    return {
      data: {
        brand: (tenant?.settings as TenantSettings | undefined)?.brand ?? {},
        timezone: next.timezone ?? null,
      },
    };
  });

  let nodeTypesCache: unknown;
  app.get('/node-types', async (request) => {
    requireAuth(request);
    nodeTypesCache ??= plain(registries.nodeTypes.list().map((t) => t.description));
    return { data: nodeTypesCache };
  });

  let credentialTypesCache: CredentialTypeDescription[] | undefined;
  app.get('/credential-types', async (request) => {
    requireAuth(request);
    credentialTypesCache ??= registries.credentialTypes.list().map((type) => {
      const resolved = registries.credentialTypes.getResolved(type.name) ?? type;
      const { authenticate, preAuthentication, ...rest } = resolved;
      return plain({
        ...rest,
        extends: type.extends,
        hasAuthenticate: Boolean(authenticate),
        isOAuth2: registries.credentialTypes.isA(type.name, 'oAuth2Api'),
      }) as CredentialTypeDescription;
    });
    return { data: credentialTypesCache };
  });

  app.post('/node-types/options', async (request) => {
    const auth = requireRole(request, 'editor');
    const body = parse(optionsSchema, request.body);
    const type = registries.nodeTypes.get(body.nodeType);
    if (!type) throw ApiError.badRequest(`Unknown node type "${body.nodeType}"`);
    const method =
      body.kind === 'loadOptions'
        ? type.methods?.loadOptions?.[body.method]
        : type.methods?.listSearch?.[body.method];
    if (!method)
      throw ApiError.badRequest(`Node type "${body.nodeType}" has no ${body.kind} method "${body.method}"`);
    const node = { ...body.node, type: body.nodeType } as WorkflowNode;
    const workflow = new Workflow({ name: 'options', nodes: [node], connections: {} }, registries.nodeTypes);
    const services = await ctx.executions.buildServices({
      tenant: auth.tenant,
      executionId: '',
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
    };
    try {
      const result =
        body.kind === 'loadOptions'
          ? await (method as (c: LoadOptionsContext) => Promise<unknown>)(loadCtx)
          : await (method as (c: LoadOptionsContext, f?: string, t?: string) => Promise<unknown>)(
              loadCtx,
              body.filter,
              body.paginationToken,
            );
      return { data: result };
    } catch (error) {
      throw new ApiError(400, 'options_error', (error as Error).message);
    }
  });
}
