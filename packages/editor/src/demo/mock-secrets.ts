/**
 * Demo routes for external secret connections (P4-07), registered by the MockBackend constructor.
 *
 * They follow the server's rules: admins and owners manage connections, editors read secret names,
 * a connection key is letters and digits, secret settings come back blanked and a blanked value
 * sent back keeps the stored one, a new connection is off until enabled, a failed connect shows a
 * fixed text. State lives in `backend.ext.secrets`.
 */
import { EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES, type Scope } from '@workflow/workflow';
import type {
  SecretConnection,
  SecretConnectionCreateBody,
  SecretConnectionPatchBody,
  SecretProviderTypeInfo,
} from '../api/types';
import { REDACTED } from '../api/types';
import { newId } from '../lib/ids';
import { MISSING_SCOPE, type MockBackend, type StoredProject } from './mock-backend';
import { copy, HttpError, now } from './mock-http';

export const DEMO_SECRET_PROVIDER_TYPES: SecretProviderTypeInfo[] = [
  {
    name: 'vault',
    displayName: 'HashiCorp Vault',
    properties: [
      {
        displayName: 'Vault URL',
        name: 'url',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://vault.example.com/v1/',
      },
      { displayName: 'Namespace', name: 'namespace', type: 'string', default: '' },
      {
        displayName: 'Authentication Method',
        name: 'authMethod',
        type: 'options',
        default: 'token',
        options: [
          { name: 'Token', value: 'token' },
          { name: 'AppRole', value: 'appRole' },
        ],
      },
      {
        displayName: 'Token',
        name: 'token',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { password: true },
        displayOptions: { show: { authMethod: ['token'] } },
      },
      {
        displayName: 'Role ID',
        name: 'roleId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { authMethod: ['appRole'] } },
      },
      {
        displayName: 'Secret ID',
        name: 'secretId',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { password: true },
        displayOptions: { show: { authMethod: ['appRole'] } },
      },
    ],
  },
  {
    name: 'awsSecretsManager',
    displayName: 'AWS Secrets Manager',
    properties: [
      { displayName: 'Region', name: 'region', type: 'string', default: '', required: true },
      { displayName: 'Access Key ID', name: 'accessKeyId', type: 'string', default: '', required: true },
      {
        displayName: 'Secret Access Key',
        name: 'secretAccessKey',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { password: true },
      },
    ],
  },
];

/** secret names every connected demo connection holds */
const DEMO_SECRET_NAMES = ['apiKey', 'dbPassword', 'webhookToken'];

interface StoredConnection extends Omit<SecretConnection, 'credentialsCount' | 'projects'> {
  tenantId: string;
  /** a workspace connection shared with these projects (`projectId` is unset) */
  projectIds?: string[];
}

interface SecretState {
  connections: StoredConnection[];
  /** P6-28: the workspace switch, by tenant */
  systemRoles?: Record<string, boolean>;
}

function secretState(backend: MockBackend): SecretState {
  backend.ext.secrets ??= { connections: [] } satisfies SecretState;
  return backend.ext.secrets as SecretState;
}

const notFound = () => new HttpError(404, 'not_found', 'Connection not found');
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function passwordNames(type: SecretProviderTypeInfo): Set<string> {
  return new Set(type.properties.filter((p) => p.typeOptions?.password).map((p) => p.name));
}

function typeOf(name: string): SecretProviderTypeInfo {
  const type = DEMO_SECRET_PROVIDER_TYPES.find((t) => t.name === name);
  if (!type) throw badRequest(`Unknown provider type "${name}"`);
  return type;
}

/** a setting that says "invalid" fails to connect, so the demo can show the error state */
function failing(settings: Record<string, unknown>): boolean {
  return Object.values(settings).some((v) => typeof v === 'string' && v.toLowerCase().includes('invalid'));
}

export function registerSecretRoutes(backend: MockBackend): void {
  const state = () => secretState(backend);
  const rowOf = (tenantId: string, key: string): StoredConnection => {
    const row = state().connections.find((c) => c.tenantId === tenantId && c.providerKey === key);
    if (!row) throw notFound();
    return row;
  };
  const usedBy = (tenantId: string, key: string): number =>
    backend.credentials.filter(
      (c) =>
        c.tenantId === tenantId &&
        Object.values(c.data).some((v) => typeof v === 'string' && v.includes(`$secrets.${key}.`)),
    ).length;
  const dto = (row: StoredConnection): SecretConnection => {
    const { tenantId, projectIds, ...rest } = row;
    const blank = passwordNames(typeOf(row.type));
    const settings = Object.fromEntries(
      Object.entries(row.settings).map(([k, v]) => [k, blank.has(k) && v ? REDACTED : v]),
    );
    const projects = (projectIds ?? [])
      .map((id) => backend.projectRef(id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    return copy({
      ...rest,
      settings,
      credentialsCount: usedBy(tenantId, row.providerKey),
      ...(projects.length > 0 ? { projects } : {}),
    });
  };
  const connect = (row: StoredConnection): void => {
    const bad = failing(row.settings);
    row.state = bad ? 'error' : 'connected';
    row.lastError = bad ? "Couldn't connect to the provider" : null;
    row.secretsCount = bad ? 0 : DEMO_SECRET_NAMES.length;
    row.updatedAt = now();
  };
  const mergeSettings = (type: SecretProviderTypeInfo, stored: Record<string, unknown>, sent: unknown) => {
    const next = copy((sent ?? {}) as Record<string, unknown>);
    for (const name of passwordNames(type)) if (next[name] === REDACTED) next[name] = stored[name];
    return next;
  };
  const knownProjects = (tenantId: string, ids: unknown[]): string[] =>
    ids.filter(
      (id): id is string =>
        typeof id === 'string' && backend.projects.some((p) => p.id === id && p.tenantId === tenantId),
    );
  const applyPatch = (row: StoredConnection, patch: SecretConnectionPatchBody): SecretConnection => {
    if (patch.type !== undefined && patch.type !== row.type) {
      typeOf(patch.type);
      row.type = patch.type;
      row.settings = {};
    }
    if (patch.settings !== undefined)
      row.settings = mergeSettings(typeOf(row.type), row.settings, patch.settings);
    if (patch.isEnabled !== undefined) row.isEnabled = patch.isEnabled;
    if (row.isEnabled) connect(row);
    else {
      row.state = 'initialized';
      row.lastError = null;
      row.secretsCount = 0;
      row.updatedAt = now();
    }
    return dto(row);
  };
  const testResult = (row: StoredConnection) => {
    if (failing(row.settings))
      return { success: false, testState: 'error', error: "Couldn't connect to the provider" };
    return { success: true, testState: row.isEnabled ? 'connected' : 'tested' };
  };
  const newRow = (
    tenantId: string,
    input: Partial<SecretConnectionCreateBody>,
    projectId: string | null,
  ): StoredConnection => {
    if (typeof input.providerKey !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,127}$/.test(input.providerKey))
      throw badRequest('The connection name must start with a letter and hold only letters and numbers');
    typeOf(String(input.type));
    if (state().connections.some((c) => c.tenantId === tenantId && c.providerKey === input.providerKey))
      throw new HttpError(409, 'conflict', 'A connection with this name already exists');
    const stamp = now();
    return {
      id: newId(),
      tenantId,
      ...(projectId ? { projectId } : {}),
      providerKey: input.providerKey,
      type: String(input.type),
      settings: copy(input.settings ?? {}),
      isEnabled: false,
      state: 'initialized',
      lastError: null,
      secretsCount: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };

  backend.on('GET', '/secret-providers/types', () => {
    backend.requireScope('externalSecretsProvider:list');
    return copy(DEMO_SECRET_PROVIDER_TYPES);
  });
  backend.on('GET', '/secret-providers/types/:type', ({ params }) => {
    backend.requireScope('externalSecretsProvider:list');
    const type = DEMO_SECRET_PROVIDER_TYPES.find((t) => t.name === params[0]);
    if (!type) throw new HttpError(404, 'not_found', 'Provider type not found');
    return copy(type);
  });
  backend.on('GET', '/secret-providers/completions/secrets', () => {
    const { tenant } = backend.requireScope('externalSecret:list');
    return Object.fromEntries(
      state()
        .connections.filter(
          (c) => c.tenantId === tenant.id && !c.projectId && c.isEnabled && c.state === 'connected',
        )
        .map((c) => [c.providerKey, [...DEMO_SECRET_NAMES]]),
    );
  });
  backend.on('GET', '/secret-providers/connections', () => {
    const { tenant } = backend.requireScope('externalSecretsProvider:list');
    return state()
      .connections.filter((c) => c.tenantId === tenant.id && !c.projectId)
      .map(dto);
  });
  backend.on('POST', '/secret-providers/connections', ({ body }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:create');
    const input = (body ?? {}) as Partial<SecretConnectionCreateBody>;
    const row = newRow(tenant.id, input, null);
    if (Array.isArray(input.projectIds)) row.projectIds = knownProjects(tenant.id, input.projectIds);
    state().connections.push(row);
    return dto(row);
  });
  backend.on('GET', '/secret-providers/connections/:providerKey', ({ params }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:read');
    return dto(rowOf(tenant.id, params[0]));
  });
  backend.on('PATCH', '/secret-providers/connections/:providerKey', ({ params, body }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:update');
    const row = rowOf(tenant.id, params[0]);
    const patch = (body ?? {}) as SecretConnectionPatchBody;
    if (Array.isArray(patch.projectIds)) row.projectIds = knownProjects(tenant.id, patch.projectIds);
    return applyPatch(row, patch);
  });
  backend.on('DELETE', '/secret-providers/connections/:providerKey', ({ params }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:delete');
    const row = rowOf(tenant.id, params[0]);
    state().connections = state().connections.filter((c) => c !== row);
    return { ok: true };
  });
  backend.on('POST', '/secret-providers/connections/:providerKey/test', ({ params }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:update');
    return testResult(rowOf(tenant.id, params[0]));
  });
  backend.on('POST', '/secret-providers/connections/:providerKey/reload', ({ params }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:sync');
    const row = rowOf(tenant.id, params[0]);
    if (row.isEnabled) connect(row);
    return { success: row.state !== 'error' };
  });

  // P6-28: the workspace switch that gives project admin (full) and project editor (read) the vault scopes
  backend.on('GET', '/external-secrets/settings', () => {
    const { tenant } = backend.requireScope('externalSecretsProvider:list');
    return { systemRolesEnabled: state().systemRoles?.[tenant.id] === true };
  });
  backend.on('POST', '/external-secrets/settings', ({ body }) => {
    const { tenant } = backend.requireScope('externalSecretsProvider:update');
    const on = body?.systemRolesEnabled;
    if (typeof on !== 'boolean') throw badRequest('systemRolesEnabled must be true or false');
    state().systemRoles = { ...state().systemRoles, [tenant.id]: on };
    return { systemRolesEnabled: on };
  });

  // P6-28: a project's own vaults, and the workspace ones shared with it
  const scopesIn = (project: StoredProject): Set<Scope> => {
    const scopes = new Set<Scope>(backend.projectScopes(project));
    if (state().systemRoles?.[project.tenantId] === true) {
      const { user } = backend.auth();
      const relation = backend.projectRelations.find(
        (r) => r.projectId === project.id && r.userId === user.id,
      );
      if (relation?.role === 'project:admin' || relation?.role === 'project:editor')
        for (const scope of EXTERNAL_SECRETS_SYSTEM_ROLE_SCOPES[relation.role]) scopes.add(scope);
    }
    return scopes;
  };
  const inProject = (projectId: string, scope: Scope) => {
    const { tenant } = backend.auth();
    const project = backend.projects.find((p) => p.id === projectId && p.tenantId === tenant.id);
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    if (!scopesIn(project).has(scope)) throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    return tenant;
  };
  const reachable = (tenantId: string, projectId: string) =>
    state().connections.filter(
      (c) =>
        c.tenantId === tenantId && (c.projectId === projectId || (c.projectIds ?? []).includes(projectId)),
    );
  const ownRow = (tenantId: string, projectId: string, key: string): StoredConnection => {
    const row = state().connections.find(
      (c) => c.tenantId === tenantId && c.projectId === projectId && c.providerKey === key,
    );
    if (!row)
      throw new HttpError(404, 'not_found', `Connection with key ${key} not found in project ${projectId}`);
    return row;
  };
  const base = '/secret-providers/projects/:projectId/connections';
  backend.on('GET', base, ({ params }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:list');
    return reachable(tenant.id, params[0]).map(dto);
  });
  backend.on('POST', base, ({ params, body }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:create');
    const row = newRow(tenant.id, (body ?? {}) as Partial<SecretConnectionCreateBody>, params[0]);
    state().connections.push(row);
    return dto(row);
  });
  backend.on('GET', `${base}/:providerKey`, ({ params }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:read');
    const row = reachable(tenant.id, params[0]).find((c) => c.providerKey === params[1]);
    if (!row) throw notFound();
    return dto(row);
  });
  backend.on('PATCH', `${base}/:providerKey`, ({ params, body }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:update');
    return applyPatch(ownRow(tenant.id, params[0], params[1]), (body ?? {}) as SecretConnectionPatchBody);
  });
  backend.on('DELETE', `${base}/:providerKey`, ({ params }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:delete');
    const row = ownRow(tenant.id, params[0], params[1]);
    state().connections = state().connections.filter((c) => c !== row);
    return { ok: true };
  });
  backend.on('POST', `${base}/:providerKey/test`, ({ params }) => {
    const tenant = inProject(params[0], 'externalSecretsProvider:update');
    return testResult(ownRow(tenant.id, params[0], params[1]));
  });
  backend.on('GET', '/secret-providers/completions/secrets/project/:projectId', ({ params }) => {
    const tenant = inProject(params[0], 'externalSecret:list');
    return Object.fromEntries(
      reachable(tenant.id, params[0])
        .filter((c) => c.isEnabled && c.state === 'connected')
        .map((c) => [c.providerKey, [...DEMO_SECRET_NAMES]]),
    );
  });
}
