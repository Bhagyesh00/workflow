/** /rest/settings, /rest/node-types, /rest/credential-types */
import { rm } from 'node:fs/promises';
import path from 'node:path';
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
import { clearSessionCookie, requireAuth, requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { decodeCursor, encodeCursor } from '../http/pagination';
import { nodeSchema } from '../http/schemas';
import { currentPeriod, effectiveLimits, PLANS, type TenantSettings } from '../plans';
import { isUuid } from '../repositories/util';

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
  /** P3-19 */
  workflowReviews: z.object({ enabled: z.boolean() }).optional(),
});

const optionsSchema = z.object({
  nodeType: z.string().min(1),
  method: z.string().min(1),
  kind: z.enum(['loadOptions', 'listSearch']),
  node: nodeSchema,
  filter: z.string().max(1000).optional(),
  paginationToken: z.string().max(2000).optional(),
  /** the workflow open in the editor (left out of workflow pickers) */
  workflowId: z.string().uuid().optional(),
});

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
        autosaveEnabled: !config.autosaveDisabled,
        workflowReviews: { enabled: tenantSettings.workflowReviews?.enabled === true },
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
      ...(body.workflowReviews
        ? { workflowReviews: { ...(current.workflowReviews ?? {}), ...body.workflowReviews } }
        : {}),
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
        autosaveEnabled: !config.autosaveDisabled,
        workflowReviews: { enabled: next.workflowReviews?.enabled === true },
      },
    };
  });

  // owners can delete the whole workspace (all its data, cascading); the slug must be confirmed
  app.delete('/tenant', async (request, reply) => {
    const auth = requireRole(request, 'owner');
    const { confirm } = parse(z.object({ confirm: z.string() }), request.body ?? {});
    if (confirm !== auth.tenant.slug) {
      throw ApiError.badRequest('Confirm the deletion with the workspace slug in "confirm"');
    }
    const active = await repos.workflows.list(auth.tenant.id, { active: true, limit: 10_000 });
    for (const wf of active) await ctx.activeWorkflows.deactivate(auth.tenant.id, wf.id);
    await repos.tenants.delete(auth.tenant.id);
    await rm(path.join(config.binaryData.dir, auth.tenant.id), { recursive: true, force: true }).catch(
      () => {},
    );
    clearSessionCookie(reply, config);
    request.log.info({ tenantId: auth.tenant.id, userId: auth.user.id }, 'Workspace deleted');
    return { data: { ok: true } };
  });

  let nodeTypesCache: unknown;
  app.get('/node-types', async (request) => {
    requireAuth(request);
    nodeTypesCache ??= plain(registries.nodeTypes.list().map((t) => t.description));
    return { data: nodeTypesCache, nextCursor: null };
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
        isOAuth1: registries.credentialTypes.isA(type.name, 'oAuth1Api'),
        isOAuth2: registries.credentialTypes.isA(type.name, 'oAuth2Api'),
      }) as CredentialTypeDescription;
    });
    return { data: credentialTypesCache, nextCursor: null };
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
    const workflow = new Workflow(
      { id: body.workflowId, name: 'options', nodes: [node], connections: {} },
      registries.nodeTypes,
    );
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
      listWorkflows: async ({ filter, paginationToken, excludeId }) => {
        // one row more than a page tells whether another page follows; one more again covers the excluded row
        const rows = await repos.workflows.list(auth.tenant.id, {
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
