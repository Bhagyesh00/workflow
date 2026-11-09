/**
 * /rest/secret-providers (P4-07), n8n's connections model. P6-28: every route checks a scope. The
 * workspace routes take `externalSecretsProvider:*` and `externalSecret:list` workspace wide (owner and
 * admin); a workspace connection takes `projectIds` to share it with those projects only. The project
 * routes (n8n's project connections controller) take the same scopes on `:projectId`, which a custom
 * project role, or the `externalSecrets.systemRolesEnabled` switch (project admin all, project editor
 * read), gives. Secret values never leave the manager; settings come back blanked.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import type { SecretsManager } from '../services/secrets/manager';
import type { SecretActor, SecretProviderType } from '../services/secrets/types';

/** n8n's rule; it is the name in `$secrets.<providerKey>.<secret>` */
const providerKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9]*$/);
const keyParams = z.object({ providerKey });
const typeName = z.string().min(1).max(128);
const typeParams = z.object({ type: typeName });
/** P6-28: the project's id (a non-uuid is the access service's 404) */
const projectParams = z.object({ projectId: z.string() });
const settings = z.record(z.string(), z.unknown());
/** P6-28: the projects a workspace connection is shared with (an unknown id is the manager's 404) */
const projectIds = z.array(z.string().min(1).max(64)).max(500);

const createBody = z.object({
  providerKey,
  type: typeName,
  settings,
  isEnabled: z.boolean().optional(),
  projectIds: projectIds.optional(),
});
const updateBody = z.object({
  type: typeName.optional(),
  settings: settings.optional(),
  isEnabled: z.boolean().optional(),
  projectIds: projectIds.optional(),
});

/** P6-28: n8n's UpdateExternalSecretsSettingsDto */
const systemRolesBody = z.object({ systemRolesEnabled: z.boolean() });

/** a type as the settings form reads it, without `create` */
const typeDTO = ({ name, displayName, properties }: SecretProviderType) => ({
  name,
  displayName,
  properties,
});

export function registerSecretConnectionRoutes(
  app: FastifyInstance,
  deps: { secrets: SecretsManager },
): void {
  const { secrets } = deps;
  const actor = (request: FastifyRequest): SecretActor => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  /**
   * P6-28: the scope on the project, or the system role switch for a project admin or editor of it. A
   * missing project stays the access service's 404.
   */
  const requireVaultScope = async (
    request: FastifyRequest,
    scope: Scope,
    projectId: string,
  ): Promise<AuthContext> => {
    try {
      return await requireScope(request, scope, { projectId });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;
      const auth = requireAuth(request);
      if (await secrets.systemRoleAllows(auth.tenant.id, auth.user.id, projectId, scope)) return auth;
      throw error;
    }
  };
  /** the caller's workspace wide scopes, which pass n8n's connection role check */
  const workspaceScopes = async (request: FastifyRequest, auth: AuthContext): Promise<ReadonlySet<Scope>> =>
    request.server.access ? request.server.access.scopesForAuth(auth) : new Set<Scope>();

  // P6-28: the system role switch, n8n's POST /external-secrets/settings (workspace scope); the GET is
  // the read n8n gives through its module settings, for the settings page
  app.get('/external-secrets/settings', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:read');
    return { data: { systemRolesEnabled: await secrets.systemRolesEnabled(auth.tenant.id) } };
  });

  app.post('/external-secrets/settings', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:update');
    const { systemRolesEnabled } = parse(systemRolesBody, request.body);
    const enabled = await secrets.setSystemRolesEnabled(auth.tenant.id, systemRolesEnabled, actor(request));
    return { data: { systemRolesEnabled: enabled } };
  });

  app.get('/secret-providers/types', async (request) => {
    await requireScope(request, 'externalSecretsProvider:list');
    return { data: secrets.listTypes().map(typeDTO) };
  });

  app.get('/secret-providers/types/:type', async (request) => {
    await requireScope(request, 'externalSecretsProvider:read');
    const type = secrets.getType(parse(typeParams, request.params).type);
    if (!type) throw ApiError.notFound('Provider type');
    return { data: typeDTO(type) };
  });

  // n8n's path ends in /global; both list the tenant wide connections (a project's are under /project/:id)
  for (const url of [
    '/secret-providers/completions/secrets',
    '/secret-providers/completions/secrets/global',
  ]) {
    app.get(url, async (request) => {
      const auth = await requireScope(request, 'externalSecret:list');
      return { data: await secrets.completions(auth.tenant.id) };
    });
  }

  app.get('/secret-providers/connections', async (request) => {
    // the scope is workspace wide, so every connection of the workspace is the caller's to see
    const auth = await requireScope(request, 'externalSecretsProvider:list');
    return { data: await secrets.listConnections(auth.tenant.id) };
  });

  app.post('/secret-providers/connections', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:create');
    const body = parse(createBody, request.body);
    return { data: await secrets.createConnection(auth.tenant.id, body, actor(request)) };
  });

  app.get('/secret-providers/connections/:providerKey', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:read');
    const params = parse(keyParams, request.params);
    return { data: await secrets.getConnection(auth.tenant.id, params.providerKey) };
  });

  app.patch('/secret-providers/connections/:providerKey', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:update');
    const params = parse(keyParams, request.params);
    const body = parse(updateBody, request.body);
    return { data: await secrets.updateConnection(auth.tenant.id, params.providerKey, body, actor(request)) };
  });

  app.delete('/secret-providers/connections/:providerKey', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:delete');
    const params = parse(keyParams, request.params);
    await secrets.deleteConnection(auth.tenant.id, params.providerKey, actor(request));
    return { data: { ok: true } };
  });

  app.post('/secret-providers/connections/:providerKey/test', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:read');
    const params = parse(keyParams, request.params);
    return { data: await secrets.testConnection(auth.tenant.id, params.providerKey, actor(request)) };
  });

  app.post('/secret-providers/connections/:providerKey/reload', async (request) => {
    const auth = await requireScope(request, 'externalSecretsProvider:sync');
    const params = parse(keyParams, request.params);
    return { data: await secrets.reloadConnection(auth.tenant.id, params.providerKey, actor(request)) };
  });

  // P6-28: project vaults, n8n's project connections controller; the gate first, then the body
  const projectOf = (request: FastifyRequest) => parse(projectParams, request.params).projectId;
  const keyOf = (request: FastifyRequest) => parse(keyParams, request.params).providerKey;

  /** a change through a project: the project's role on the connection must allow it (n8n) */
  const changeInProject = async (request: FastifyRequest, scope: Scope) => {
    const projectId = projectOf(request);
    const auth = await requireVaultScope(request, scope, projectId);
    const providerKey = keyOf(request);
    const held = await workspaceScopes(request, auth);
    await secrets.assertConnectionAccess(auth.tenant.id, projectId, providerKey, scope, held);
    return { auth, providerKey };
  };

  app.post('/secret-providers/projects/:projectId/connections', async (request) => {
    const projectId = projectOf(request);
    const auth = await requireVaultScope(request, 'externalSecretsProvider:create', projectId);
    // the project owns what it creates; sharing is the workspace route's
    const { projectIds: _shares, ...body } = parse(createBody, request.body);
    return {
      data: await secrets.createConnection(auth.tenant.id, { ...body, projectId }, actor(request)),
    };
  });

  app.get('/secret-providers/projects/:projectId/connections', async (request) => {
    const projectId = projectOf(request);
    const auth = await requireVaultScope(request, 'externalSecretsProvider:list', projectId);
    return { data: await secrets.listProjectConnections(auth.tenant.id, projectId) };
  });

  app.get('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    const projectId = projectOf(request);
    const auth = await requireVaultScope(request, 'externalSecretsProvider:read', projectId);
    return { data: await secrets.getProjectConnection(auth.tenant.id, projectId, keyOf(request)) };
  });

  app.patch('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    const { auth, providerKey } = await changeInProject(request, 'externalSecretsProvider:update');
    const { projectIds: _shares, ...body } = parse(updateBody, request.body);
    return { data: await secrets.updateConnection(auth.tenant.id, providerKey, body, actor(request)) };
  });

  app.delete('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    const { auth, providerKey } = await changeInProject(request, 'externalSecretsProvider:delete');
    await secrets.deleteConnection(auth.tenant.id, providerKey, actor(request));
    return { data: { ok: true } };
  });

  app.post('/secret-providers/projects/:projectId/connections/:providerKey/test', async (request) => {
    const { auth, providerKey } = await changeInProject(request, 'externalSecretsProvider:update');
    return { data: await secrets.testConnection(auth.tenant.id, providerKey, actor(request)) };
  });

  app.get('/secret-providers/completions/secrets/project/:projectId', async (request) => {
    const projectId = projectOf(request);
    const auth = await requireVaultScope(request, 'externalSecret:list', projectId);
    return { data: await secrets.projectCompletions(auth.tenant.id, projectId) };
  });
}
