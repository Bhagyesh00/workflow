/**
 * GET and PATCH /rest/assistant/settings (P5-71, lane L8): the workspace's Assistant settings, admin
 * only. Not behind the Assistant's on/off gate, so an admin can turn it back on. Credential ids are in
 * the answer, and only an admin gets it. The body is strict: an unknown key, a permission outside the 22
 * keys and `always_allow` outside `ASSISTANT_ALWAYS_ALLOW_KEYS` are 400.
 */
import {
  ASSISTANT_ALWAYS_ALLOW_KEYS,
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_MODES,
  type AssistantPermissionKey,
  type AssistantPermissionMode,
} from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clientIp, requireRole } from '../http/auth';
import { parse } from '../http/errors';
import { assistantRouteOptions } from './assistant';

const mode = z.enum(
  ASSISTANT_PERMISSION_MODES as unknown as [AssistantPermissionMode, ...AssistantPermissionMode[]],
);

/** each permission key optional; `always_allow` only where the three keys allow it */
const permissionsSchema = z
  .object(
    Object.fromEntries(ASSISTANT_PERMISSION_KEYS.map((key) => [key, mode.optional()])) as Record<
      AssistantPermissionKey,
      z.ZodOptional<typeof mode>
    >,
  )
  .strict()
  .superRefine((value, refinement) => {
    for (const [key, chosen] of Object.entries(value)) {
      if (chosen === 'always_allow' && !ASSISTANT_ALWAYS_ALLOW_KEYS.includes(key as AssistantPermissionKey)) {
        refinement.addIssue({
          code: 'custom',
          path: [key],
          message: 'This tool always needs approval',
        });
      }
    }
  });

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    credentialId: z.string().min(1).max(100).nullable().optional(),
    nodeType: z.string().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    searchCredentialId: z.string().min(1).max(100).nullable().optional(),
    searchDisabled: z.boolean().optional(),
    mcpAccessEnabled: z.boolean().optional(),
    permissions: permissionsSchema.optional(),
    allowSendingParameterValues: z.boolean().optional(),
  })
  .strict();

export function registerAssistantSettingsRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.get('/assistant/settings', assistantRouteOptions('settings-read', 'read'), async (request) => {
    const auth = requireRole(request, 'admin');
    const tenant = (await ctx.repos.tenants.get(auth.tenant.id)) ?? auth.tenant;
    return { data: await ctx.assistantSettings.dto(tenant) };
  });

  rest.patch('/assistant/settings', assistantRouteOptions('settings-patch', 'write'), async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(patchSchema, request.body ?? {});
    const actor = { userId: auth.user.id, ip: clientIp(request) };
    return { data: await ctx.assistantSettings.patch(auth, body, actor) };
  });
}
