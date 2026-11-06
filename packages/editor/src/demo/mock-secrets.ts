/**
 * Demo routes for external secret connections (P4-07), registered by the MockBackend constructor.
 *
 * They follow the server's rules: admins and owners manage connections, editors read secret names,
 * a connection key is letters and digits, secret settings come back blanked and a blanked value
 * sent back keeps the stored one, a new connection is off until enabled, a failed connect shows a
 * fixed text. State lives in `backend.ext.secrets`.
 */
import type {
  SecretConnection,
  SecretConnectionCreateBody,
  SecretConnectionPatchBody,
  SecretProviderTypeInfo,
} from '../api/types';
import { REDACTED } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
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

interface StoredConnection extends Omit<SecretConnection, 'credentialsCount'> {
  tenantId: string;
}

interface SecretState {
  connections: StoredConnection[];
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
    const { tenantId, ...rest } = row;
    const blank = passwordNames(typeOf(row.type));
    const settings = Object.fromEntries(
      Object.entries(row.settings).map(([k, v]) => [k, blank.has(k) && v ? REDACTED : v]),
    );
    return copy({ ...rest, settings, credentialsCount: usedBy(tenantId, row.providerKey) });
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

  backend.on('GET', '/secret-providers/types', () => {
    backend.requireRole('admin');
    return copy(DEMO_SECRET_PROVIDER_TYPES);
  });
  backend.on('GET', '/secret-providers/types/:type', ({ params }) => {
    backend.requireRole('admin');
    const type = DEMO_SECRET_PROVIDER_TYPES.find((t) => t.name === params[0]);
    if (!type) throw new HttpError(404, 'not_found', 'Provider type not found');
    return copy(type);
  });
  backend.on('GET', '/secret-providers/completions/secrets', () => {
    const { tenant } = backend.requireRole('editor');
    return Object.fromEntries(
      state()
        .connections.filter((c) => c.tenantId === tenant.id && c.isEnabled && c.state === 'connected')
        .map((c) => [c.providerKey, [...DEMO_SECRET_NAMES]]),
    );
  });
  backend.on('GET', '/secret-providers/connections', () => {
    const { tenant } = backend.requireRole('admin');
    return state()
      .connections.filter((c) => c.tenantId === tenant.id)
      .map(dto);
  });
  backend.on('POST', '/secret-providers/connections', ({ body }) => {
    const { tenant } = backend.requireRole('admin');
    const input = (body ?? {}) as Partial<SecretConnectionCreateBody>;
    if (typeof input.providerKey !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,127}$/.test(input.providerKey))
      throw badRequest('The connection name must start with a letter and hold only letters and numbers');
    typeOf(String(input.type));
    if (state().connections.some((c) => c.tenantId === tenant.id && c.providerKey === input.providerKey))
      throw new HttpError(409, 'conflict', 'A connection with this name already exists');
    const stamp = now();
    const row: StoredConnection = {
      id: newId(),
      tenantId: tenant.id,
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
    state().connections.push(row);
    return dto(row);
  });
  backend.on('GET', '/secret-providers/connections/:providerKey', ({ params }) => {
    const { tenant } = backend.requireRole('admin');
    return dto(rowOf(tenant.id, params[0]));
  });
  backend.on('PATCH', '/secret-providers/connections/:providerKey', ({ params, body }) => {
    const { tenant } = backend.requireRole('admin');
    const row = rowOf(tenant.id, params[0]);
    const patch = (body ?? {}) as SecretConnectionPatchBody;
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
  });
  backend.on('DELETE', '/secret-providers/connections/:providerKey', ({ params }) => {
    const { tenant } = backend.requireRole('admin');
    const row = rowOf(tenant.id, params[0]);
    state().connections = state().connections.filter((c) => c !== row);
    return { ok: true };
  });
  backend.on('POST', '/secret-providers/connections/:providerKey/test', ({ params }) => {
    const { tenant } = backend.requireRole('admin');
    const row = rowOf(tenant.id, params[0]);
    if (failing(row.settings))
      return { success: false, testState: 'error', error: "Couldn't connect to the provider" };
    return { success: true, testState: row.isEnabled ? 'connected' : 'tested' };
  });
  backend.on('POST', '/secret-providers/connections/:providerKey/reload', ({ params }) => {
    const { tenant } = backend.requireRole('admin');
    const row = rowOf(tenant.id, params[0]);
    if (row.isEnabled) connect(row);
    return { success: row.state !== 'error' };
  });
}
