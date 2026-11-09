/**
 * /rest/secret-providers (P4-07), n8n's connections model. Admin and owner manage connections and read
 * provider types; editor and above list secret names, never values. P6-28 (L8): project vaults under
 * `/secret-providers/projects/:projectId/connections` and the project's secret names, gated by
 * `externalSecretsProvider:*` and `externalSecret:list` on the project; C0 registers those 7 routes with
 * their final path and gate, and their handlers throw until L8.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, requireScope } from '../http/auth';
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

const createBody = z.object({
  providerKey,
  type: typeName,
  settings,
  isEnabled: z.boolean().optional(),
});
const updateBody = z.object({
  type: typeName.optional(),
  settings: settings.optional(),
  isEnabled: z.boolean().optional(),
});

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

  app.get('/secret-providers/types', async (request) => {
    requireRole(request, 'admin');
    return { data: secrets.listTypes().map(typeDTO) };
  });

  app.get('/secret-providers/types/:type', async (request) => {
    requireRole(request, 'admin');
    const type = secrets.getType(parse(typeParams, request.params).type);
    if (!type) throw ApiError.notFound('Provider type');
    return { data: typeDTO(type) };
  });

  // n8n's path ends in /global (its project variants are not built); both reach the same list
  for (const url of [
    '/secret-providers/completions/secrets',
    '/secret-providers/completions/secrets/global',
  ]) {
    app.get(url, async (request) => {
      const auth = requireRole(request, 'editor');
      return { data: await secrets.completions(auth.tenant.id) };
    });
  }

  app.get('/secret-providers/connections', async (request) => {
    const auth = requireRole(request, 'admin');
    return { data: await secrets.listConnections(auth.tenant.id) };
  });

  app.post('/secret-providers/connections', async (request) => {
    const auth = requireRole(request, 'admin');
    const body = parse(createBody, request.body);
    return { data: await secrets.createConnection(auth.tenant.id, body, actor(request)) };
  });

  app.get('/secret-providers/connections/:providerKey', async (request) => {
    const auth = requireRole(request, 'admin');
    const params = parse(keyParams, request.params);
    return { data: await secrets.getConnection(auth.tenant.id, params.providerKey) };
  });

  app.patch('/secret-providers/connections/:providerKey', async (request) => {
    const auth = requireRole(request, 'admin');
    const params = parse(keyParams, request.params);
    const body = parse(updateBody, request.body);
    return { data: await secrets.updateConnection(auth.tenant.id, params.providerKey, body, actor(request)) };
  });

  app.delete('/secret-providers/connections/:providerKey', async (request) => {
    const auth = requireRole(request, 'admin');
    const params = parse(keyParams, request.params);
    await secrets.deleteConnection(auth.tenant.id, params.providerKey, actor(request));
    return { data: { ok: true } };
  });

  app.post('/secret-providers/connections/:providerKey/test', async (request) => {
    const auth = requireRole(request, 'admin');
    const params = parse(keyParams, request.params);
    return { data: await secrets.testConnection(auth.tenant.id, params.providerKey, actor(request)) };
  });

  app.post('/secret-providers/connections/:providerKey/reload', async (request) => {
    const auth = requireRole(request, 'admin');
    const params = parse(keyParams, request.params);
    return { data: await secrets.reloadConnection(auth.tenant.id, params.providerKey, actor(request)) };
  });

  // P6-28 (L8): project vaults, n8n's project connections controller; C0 stubs, gate first
  const projectOf = (request: FastifyRequest) => parse(projectParams, request.params).projectId;
  const notImplemented = (): never => {
    throw new Error('not implemented (L8)');
  };

  app.post('/secret-providers/projects/:projectId/connections', async (request) => {
    await requireScope(request, 'externalSecretsProvider:create', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.get('/secret-providers/projects/:projectId/connections', async (request) => {
    await requireScope(request, 'externalSecretsProvider:list', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.get('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    await requireScope(request, 'externalSecretsProvider:read', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.patch('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    await requireScope(request, 'externalSecretsProvider:update', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.delete('/secret-providers/projects/:projectId/connections/:providerKey', async (request) => {
    await requireScope(request, 'externalSecretsProvider:delete', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.post('/secret-providers/projects/:projectId/connections/:providerKey/test', async (request) => {
    await requireScope(request, 'externalSecretsProvider:update', { projectId: projectOf(request) });
    return notImplemented();
  });

  app.get('/secret-providers/completions/secrets/project/:projectId', async (request) => {
    await requireScope(request, 'externalSecret:list', { projectId: projectOf(request) });
    return notImplemented();
  });
}
