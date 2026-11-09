/** /rest/settings, /rest/node-types, /rest/credential-types */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialTypeDescription } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clearSessionCookie, requireAuth, requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { currentPeriod, effectiveLimits, PLANS, type TenantSettings } from '../plans';
import { CREDENTIAL_MISMATCH, credentialFitsModel, isBuilderModelNode } from '../services/ai-builder/model';
import { assistantFeature } from '../services/assistant/settings';
import { hasRole } from '../services/auth';
import { loadNodeOptions } from '../services/node-options';

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
  /**
   * P5-09: the AI builder's model (admin, as the route); the credential must be this tenant's and the
   * node type a chat model node (`isBuilderModelNode`); `null` removes the setup
   */
  ai: z
    .object({
      credentialId: z.string().min(1).max(64),
      nodeType: z.string().min(1).max(128),
      model: z.string().trim().min(1).max(256),
      allowSendingParameterValues: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

/** P5-09: whether the AI builder is on for this instance and set up (a model chosen) for this tenant */
function aiBuilderFeature(enabled: boolean, settings: TenantSettings) {
  const ai = settings.ai;
  return { enabled, setup: Boolean(ai?.credentialId && ai.nodeType && ai.model) };
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
          aiBuilder: aiBuilderFeature(config.ai.enabled, tenantSettings),
          /** P5-67: the Assistant on/off and whether a model is set; never a credential id */
          assistant: assistantFeature(config, tenantSettings, registries.nodeTypes),
        },
        ...(usage
          ? { usage: { period: usage.period, executions: usage.executions, executionMs: usage.executionMs } }
          : {}),
        autosaveEnabled: !config.autosaveDisabled,
        workflowReviews: { enabled: tenantSettings.workflowReviews?.enabled === true },
        /** P6-33: the personal space policy, read from the same key as the access service (absent = on) */
        securityPolicy: {
          personalSpacePublishing: tenantSettings.securityPolicy?.personalSpacePublishing !== false,
          personalSpaceSharing: tenantSettings.securityPolicy?.personalSpaceSharing !== false,
        },
        /** P5-11: read only, the editor caps the "run in parallel" slider with it; PATCH never takes it */
        evaluationConcurrencyLimit: config.evaluationConcurrencyLimit,
        /** P5-09: the builder's model setup, admins only (it names a credential) */
        ...(auth && hasRole(auth.role, 'admin') && tenantSettings.ai ? { ai: tenantSettings.ai } : {}),
      },
    };
  });

  app.patch('/settings', async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(settingsPatch, request.body);
    const current = (auth.tenant.settings ?? {}) as TenantSettings;
    if (body.ai) {
      const credential = await repos.credentials.get(auth.tenant.id, body.ai.credentialId);
      if (!credential) throw ApiError.badRequest('The AI credential was not found in this workspace');
      if (!isBuilderModelNode(registries.nodeTypes, body.ai.nodeType)) {
        throw ApiError.badRequest(`"${body.ai.nodeType}" is not a chat model node type`);
      }
      // the same refusal the builder gives at its first turn, now when the setting is saved
      if (!credentialFitsModel(ctx, body.ai.nodeType, credential.type)) {
        throw ApiError.badRequest(CREDENTIAL_MISMATCH);
      }
    }
    const next: TenantSettings = {
      ...current,
      ...(body.brand ? { brand: { ...(current.brand ?? {}), ...body.brand } } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.workflowReviews
        ? { workflowReviews: { ...(current.workflowReviews ?? {}), ...body.workflowReviews } }
        : {}),
      ...(body.ai
        ? {
            ai: {
              credentialId: body.ai.credentialId,
              nodeType: body.ai.nodeType,
              model: body.ai.model,
              ...(body.ai.allowSendingParameterValues !== undefined
                ? { allowSendingParameterValues: body.ai.allowSendingParameterValues }
                : current.ai?.allowSendingParameterValues !== undefined
                  ? { allowSendingParameterValues: current.ai.allowSendingParameterValues }
                  : {}),
            },
          }
        : {}),
    };
    if (body.ai === null) delete next.ai;
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
        aiBuilder: aiBuilderFeature(config.ai.enabled, next),
        ...(next.ai ? { ai: next.ai } : {}),
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
    return { data: await loadNodeOptions(ctx, auth, request.body) };
  });
}
