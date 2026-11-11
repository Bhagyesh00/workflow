/** /rest/settings, /rest/node-types, /rest/credential-types */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialTypeDescription } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clearSessionCookie, requireAuth, requireOwner, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { currentPeriod, effectiveLimits, PLANS, type TenantSettings } from '../plans';
import { CREDENTIAL_MISMATCH, credentialFitsModel, isBuilderModelNode } from '../services/ai-builder/model';
import { assistantFeature } from '../services/assistant/settings';
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
    // P6-27: the AI block is read by the scope that writes it
    const manageSecurity = auth
      ? (await ctx.access.scopesForAuth(auth)).has('securitySettings:manage')
      : false;
    const usage = auth ? await repos.usage.get(auth.tenant.id, currentPeriod()) : undefined;
    // P6-84: active workflows (tenant scoped) against `limits.activeWorkflows`
    const activeWorkflows = auth ? await repos.workflows.countActive(auth.tenant.id) : 0;
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
          /** off with PUBLIC_API_DISABLED (then /api/v1 answers 404) */
          publicApi: !config.publicApiDisabled,
          /** P6-17: mail is set up (invites, resets and share mails go out) */
          mail: ctx.mailer.isConfigured(),
          /** P6-18: MFA can be set up (MFA_ENABLED) */
          mfa: config.mfaEnabled,
          versionHistory: true,
          versionDiff: true,
          workflowValidation: true,
          webhookIdempotency: true,
          ssrfProtection: config.ssrf.enabled,
          aiBuilder: aiBuilderFeature(config.ai.enabled, tenantSettings),
          /** P5-67: the Assistant on/off and whether a model is set; never a credential id */
          assistant: assistantFeature(config, tenantSettings, registries.nodeTypes),
        },
        // P6-84: the active count is sent even before any run of the month (no usage row yet)
        ...(auth
          ? {
              usage: {
                period: usage?.period ?? currentPeriod(),
                executions: usage?.executions ?? 0,
                executionMs: usage?.executionMs ?? 0,
                activeWorkflows,
              },
            }
          : {}),
        autosaveEnabled: !config.autosaveDisabled,
        workflowReviews: { enabled: tenantSettings.workflowReviews?.enabled === true },
        /** P6-18: the workspace enforces two-factor sign-in (POST /settings/mfa-enforce writes it) */
        mfa: { enforced: tenantSettings.mfa?.enforced === true },
        /** P6-33: the personal space policy, read from the same key as the access service (absent = on) */
        securityPolicy: {
          personalSpacePublishing: tenantSettings.securityPolicy?.personalSpacePublishing !== false,
          personalSpaceSharing: tenantSettings.securityPolicy?.personalSpaceSharing !== false,
        },
        /** P6-53: the workspace's redaction floor (absent = off); every user reads it, no platform env is sent */
        redactionFloor: tenantSettings.redactionFloor ?? 'off',
        /** P5-11: read only, the editor caps the "run in parallel" slider with it; PATCH never takes it */
        evaluationConcurrencyLimit: config.evaluationConcurrencyLimit,
        /** P5-09: the builder's model setup, admins only (it names a credential) */
        ...(manageSecurity && tenantSettings.ai ? { ai: tenantSettings.ai } : {}),
      },
    };
  });

  app.patch('/settings', async (request) => {
    const auth = await requireScope(request, 'securitySettings:manage');
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
    const auth = requireOwner(request);
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
    // the scope check lives in loadNodeOptions (the Assistant tool reaches it too)
    const auth = requireAuth(request);
    return { data: await loadNodeOptions(ctx, auth, request.body) };
  });
}
