/**
 * /rest/assistant/mcp-connections (P5-72, lane L9): the workspace's MCP servers for the Assistant. GET
 * viewer, POST, PATCH `/:id`, DELETE `/:id` admin. The gate: signed out 401, MCP access off for this
 * workspace (`TenantSettings.assistant.mcpAccessEnabled`, off by default) 404, then the role (403). A
 * connection holds a credential id, never a secret. Gates and rate limits are final from C0; the
 * handlers answer `{ data }` like the other Assistant routes, and a credential is checked against the
 * workspace and the sign-in method before it is saved.
 */
import {
  ASSISTANT_PERMISSION_MODES,
  type AssistantMcpConnectionDTO,
  type AssistantPermissionMode,
  type Scope,
} from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, clientIp, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import type { TenantSettings } from '../plans';
import type { AssistantMcpConnectionInput, AssistantMcpConnectionRow } from '../repositories/assistant-mcp';
import { isUniqueViolation } from '../repositories/util';
import { MCP_CREDENTIAL_TYPES, validateMcpUrl } from '../services/assistant/mcp';
import { effectiveAssistantSettings } from '../services/assistant/settings';
import { assertCredentialsUsable } from '../services/credential-usable';
import { assistantRouteOptions } from './assistant';

/**
 * 401 signed out, 404 while MCP access is off for the workspace, then the scope (403). The connections are
 * workspace settings, no project's: listing needs `instanceAi:message`, a write `instanceAi:manage`.
 */
export async function requireAssistantMcp(
  request: FastifyRequest,
  ctx: ServerContext,
  scope: Scope,
): Promise<AuthContext> {
  const signedIn = requireAuth(request);
  const settings = effectiveAssistantSettings(ctx.config, signedIn.tenant.settings as TenantSettings);
  if (!settings.mcpAccessEnabled) throw ApiError.notFound();
  return requireScope(request, scope);
}

/** the editor's shape of a connection: the credential id, never a secret */
export function mcpConnectionDto(row: AssistantMcpConnectionRow): AssistantMcpConnectionDTO {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    authentication: row.authentication,
    credentialId: row.credentialId,
    enabled: row.enabled,
    toolPermissions: { ...(row.toolPermissions ?? {}) },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const AUTHENTICATIONS = ['none', 'bearerAuth', 'headerAuth', 'multipleHeadersAuth', 'mcpOAuth2Api'] as const;

/** per tool: only the modes that tighten the workspace's MCP permissions */
const toolPermissionsSchema = z
  .record(
    z.string().trim().min(1).max(128),
    z.enum(ASSISTANT_PERMISSION_MODES as unknown as [AssistantPermissionMode, ...AssistantPermissionMode[]]),
  )
  .refine((value) => Object.keys(value).length <= 200, 'Too many tools')
  .refine(
    (value) => Object.values(value).every((mode) => mode !== 'always_allow'),
    'A tool permission can only tighten the workspace setting',
  );

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    url: z.string().trim().min(1).max(2000),
    transport: z.enum(['httpStreamable', 'sse']).optional(),
    authentication: z.enum(AUTHENTICATIONS).optional(),
    credentialId: z.string().min(1).max(100).nullable().optional(),
    enabled: z.boolean().optional(),
    toolPermissions: toolPermissionsSchema.optional(),
  })
  .strict();

const patchSchema = createSchema.partial().strict();

/** the address, the sign-in method and its credential, checked together against the workspace */
async function checkConnection(
  ctx: ServerContext,
  auth: AuthContext,
  next: {
    url: string;
    authentication: AssistantMcpConnectionRow['authentication'];
    credentialId: string | null;
  },
): Promise<void> {
  const url = validateMcpUrl(next.url);
  if (!url.ok) throw ApiError.badRequest(url.reason);
  const wanted = MCP_CREDENTIAL_TYPES[next.authentication];
  if (!wanted) {
    if (next.credentialId) throw ApiError.badRequest('Choose a sign-in method to use a credential');
    return;
  }
  if (!next.credentialId) throw ApiError.badRequest('Choose a credential for this sign-in method');
  // the foreign key alone does not say the credential is this workspace's
  const tenantId = auth.tenant.id;
  const credential = await ctx.repos.credentials.get(tenantId, next.credentialId);
  if (!credential) throw ApiError.badRequest('The credential was not found in this workspace');
  if (credential.type !== wanted) {
    throw ApiError.badRequest(`This sign-in method needs a ${wanted} credential`);
  }
  // the admin who saves it must be able to use it; every member's turn then uses it (workspace-wide)
  await assertCredentialsUsable(ctx, tenantId, await ctx.access.targetProject(auth), {
    name: 'Assistant MCP connection',
    nodes: [
      {
        id: 'assistant-mcp-connection',
        name: 'MCP connection',
        type: 'assistant.mcpConnection',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
        credentials: { [wanted]: { id: next.credentialId, name: credential.name } },
      },
    ],
    connections: {},
  });
}

async function audit(
  ctx: ServerContext,
  request: FastifyRequest,
  auth: AuthContext,
  action: string,
  id: string,
  name: string,
): Promise<void> {
  await ctx.repos.audit.add(auth.tenant.id, {
    userId: auth.user.id,
    action,
    resourceType: 'assistant_mcp_connection',
    resourceId: id,
    metadata: { name },
    ip: clientIp(request),
  });
}

export function registerAssistantMcpRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.get('/assistant/mcp-connections', assistantRouteOptions('mcp-list', 'read'), async (request) => {
    const auth = await requireAssistantMcp(request, ctx, 'instanceAi:message');
    const rows = await ctx.repos.assistantMcp.list(auth.tenant.id);
    return { data: rows.map(mcpConnectionDto) };
  });

  rest.post('/assistant/mcp-connections', assistantRouteOptions('mcp-create', 'write'), async (request) => {
    const auth = await requireAssistantMcp(request, ctx, 'instanceAi:manage');
    const body = parse(createSchema, request.body);
    const input = {
      name: body.name,
      url: body.url,
      transport: body.transport ?? 'httpStreamable',
      authentication: body.authentication ?? 'none',
      credentialId: body.credentialId ?? null,
      enabled: body.enabled ?? true,
      toolPermissions: body.toolPermissions ?? {},
    } satisfies AssistantMcpConnectionInput;
    await checkConnection(ctx, auth, input);
    try {
      const row = await ctx.repos.assistantMcp.create(auth.tenant.id, input, auth.user.id);
      await audit(ctx, request, auth, 'assistant.mcp_connection_created', row.id, row.name);
      return { data: mcpConnectionDto(row) };
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict(`A connection named "${body.name}" already exists`);
      throw error;
    }
  });

  rest.patch(
    '/assistant/mcp-connections/:id',
    assistantRouteOptions('mcp-update', 'write'),
    async (request) => {
      const auth = await requireAssistantMcp(request, ctx, 'instanceAi:manage');
      const { id } = request.params as { id: string };
      const body = parse(patchSchema, request.body ?? {});
      const current = await ctx.repos.assistantMcp.get(auth.tenant.id, id);
      if (!current) throw ApiError.notFound('Connection');
      const patch: Partial<AssistantMcpConnectionInput> = { ...body };
      const authentication = body.authentication ?? current.authentication;
      // choosing "none" without naming a credential also drops the old one
      let credentialId = body.credentialId !== undefined ? body.credentialId : current.credentialId;
      if (body.authentication === 'none' && body.credentialId === undefined) credentialId = null;
      if (credentialId !== current.credentialId || body.credentialId !== undefined) {
        patch.credentialId = credentialId;
      }
      await checkConnection(ctx, auth, {
        url: body.url ?? current.url,
        authentication,
        credentialId,
      });
      try {
        const row = await ctx.repos.assistantMcp.update(auth.tenant.id, id, patch);
        if (!row) throw ApiError.notFound('Connection');
        await audit(ctx, request, auth, 'assistant.mcp_connection_updated', row.id, row.name);
        return { data: mcpConnectionDto(row) };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw ApiError.conflict(`A connection named "${body.name ?? current.name}" already exists`);
        }
        throw error;
      }
    },
  );

  rest.delete(
    '/assistant/mcp-connections/:id',
    assistantRouteOptions('mcp-delete', 'write'),
    async (request) => {
      const auth = await requireAssistantMcp(request, ctx, 'instanceAi:manage');
      const { id } = request.params as { id: string };
      const current = await ctx.repos.assistantMcp.get(auth.tenant.id, id);
      if (!current || !(await ctx.repos.assistantMcp.delete(auth.tenant.id, id))) {
        throw ApiError.notFound('Connection');
      }
      await audit(ctx, request, auth, 'assistant.mcp_connection_deleted', id, current.name);
      return { data: { ok: true as const } };
    },
  );
}
