/**
 * P6-12 (L10): the demo's LDAP settings: the config (n8n's defaults, the bind password blank on read and kept
 * on a blank save), the connection test and the sync runs against a small built-in directory of four people.
 * It answers the server's codes and texts: 400 `ldap_config_missing` without a saved config, 400 for a bad
 * value, 400 `sso_switch_through_email` when another method is on, 403 for a missing scope. A live run creates the people not synced yet, a dry run only counts them; the history keeps
 * the runs newest first.
 */
import type { LdapConfig, LdapSyncRun } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { copy, HttpError, now } from './mock-http';
import { demoSsoOptions } from './mock-sso';

/** the people of the demo directory (the sync's scan) */
export const DEMO_LDAP_PEOPLE = ['ada', 'grace', 'linus', 'margaret'] as const;

const DEFAULTS: LdapConfig = {
  loginEnabled: false,
  loginLabel: '',
  connectionUrl: '',
  allowUnauthorizedCerts: false,
  connectionSecurity: 'none',
  connectionPort: 389,
  baseDn: '',
  bindingAdminDn: '',
  bindingAdminPassword: '',
  firstNameAttribute: '',
  lastNameAttribute: '',
  emailAttribute: '',
  loginIdAttribute: '',
  ldapIdAttribute: '',
  userFilter: '',
  synchronizationEnabled: false,
  synchronizationInterval: 60,
  searchPageSize: 0,
  searchTimeout: 60,
  enforceEmailUniqueness: true,
  linkExistingAccountsByEmail: false,
};

interface LdapState {
  config: LdapConfig;
  /** a bind password is saved */
  passwordSet: boolean;
  /** the demo people already created by a live run */
  synced: Set<string>;
  runs: LdapSyncRun[];
}

function stateOf(backend: MockBackend, tenantId: string): LdapState {
  const all = (backend.ext.ldap ??= {}) as Record<string, LdapState>;
  return (all[tenantId] ??= {
    config: copy(DEFAULTS),
    passwordSet: false,
    synced: new Set(),
    runs: [],
  });
}

const view = (state: LdapState): LdapConfig => ({ ...copy(state.config), bindingAdminPassword: '' });

const REQUIRED_TO_RUN: Array<[keyof LdapConfig, string]> = [
  ['connectionUrl', 'The server address'],
  ['baseDn', 'The base DN'],
  ['emailAttribute', 'The email attribute'],
  ['loginIdAttribute', 'The login ID attribute'],
  ['ldapIdAttribute', 'The LDAP ID attribute'],
];
const ATTRIBUTE = /^$|^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const bad = (message: string) => new HttpError(400, 'bad_request', message);
const runnable = (config: LdapConfig) => REQUIRED_TO_RUN.every(([key]) => String(config[key]).trim());

function apply(state: LdapState, ssoMethod: () => string, body: Record<string, unknown>): void {
  const next: LdapConfig = { ...state.config };
  const text = (key: keyof LdapConfig, max: number) => {
    if (body[key] === undefined) return;
    if (typeof body[key] !== 'string' || (body[key] as string).length > max)
      throw bad(`Invalid LDAP settings: ${key}`);
    (next as unknown as Record<string, unknown>)[key] = (body[key] as string).trim();
  };
  const flag = (key: keyof LdapConfig) => {
    if (body[key] === undefined) return;
    if (typeof body[key] !== 'boolean') throw bad(`Invalid LDAP settings: ${key}`);
    (next as unknown as Record<string, unknown>)[key] = body[key];
  };
  const whole = (key: keyof LdapConfig, min: number, max: number) => {
    if (body[key] === undefined) return;
    const value = body[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw bad(`Invalid LDAP settings: ${key}`);
    }
    (next as unknown as Record<string, unknown>)[key] = value;
  };
  for (const key of ['loginLabel', 'baseDn', 'bindingAdminDn'] as const) text(key, 1024);
  text('connectionUrl', 253);
  text('userFilter', 1024);
  for (const key of [
    'firstNameAttribute',
    'lastNameAttribute',
    'emailAttribute',
    'loginIdAttribute',
    'ldapIdAttribute',
  ] as const) {
    text(key, 128);
    if (!ATTRIBUTE.test(next[key]))
      throw bad(`Invalid LDAP settings: ${key} must be an attribute name, such as mail or uid`);
  }
  if (next.connectionUrl && !HOST.test(next.connectionUrl)) {
    throw bad(
      'Invalid LDAP settings: connectionUrl must be a host name or address without ldap:// or a port',
    );
  }
  if (next.userFilter && !(next.userFilter.startsWith('(') && next.userFilter.endsWith(')'))) {
    throw bad(
      'Invalid LDAP settings: userFilter must be one filter in parentheses, such as (objectClass=person)',
    );
  }
  if (body.connectionSecurity !== undefined) {
    if (!['none', 'tls', 'startTls'].includes(String(body.connectionSecurity))) {
      throw bad('Invalid LDAP settings: connectionSecurity');
    }
    next.connectionSecurity = body.connectionSecurity as LdapConfig['connectionSecurity'];
  }
  whole('connectionPort', 1, 65535);
  whole('synchronizationInterval', 1, 10_080);
  whole('searchPageSize', 0, 100_000);
  whole('searchTimeout', 0, 3600);
  for (const key of [
    'allowUnauthorizedCerts',
    'synchronizationEnabled',
    'enforceEmailUniqueness',
    'linkExistingAccountsByEmail',
  ] as const) {
    flag(key);
  }
  if (!next.connectionUrl) throw bad('The server address is required');
  const wantsLogin = typeof body.loginEnabled === 'boolean' ? body.loginEnabled : state.config.loginEnabled;
  if (wantsLogin || next.synchronizationEnabled) {
    const missing = REQUIRED_TO_RUN.filter(([key]) => !String(next[key]).trim()).map(([, label]) => label);
    if (missing.length) throw bad(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
  }
  if (typeof body.loginEnabled === 'boolean' && body.loginEnabled && !state.config.loginEnabled) {
    if (ssoMethod() !== 'email' && ssoMethod() !== 'ldap') {
      throw new HttpError(
        400,
        'sso_switch_through_email',
        'Turn the current sign-in method off first. A workspace moves from one sign-in method to another through email sign-in.',
      );
    }
  }
  next.loginEnabled = wantsLogin;
  state.config = next;
  const given = body.bindingAdminPassword;
  if (typeof given === 'string' && given !== '') state.passwordSet = true;
}

function finish(state: LdapState, mode: 'dry' | 'live'): LdapSyncRun {
  const startedAt = now();
  const fresh = DEMO_LDAP_PEOPLE.filter((uid) => !state.synced.has(uid));
  if (mode === 'live') for (const uid of fresh) state.synced.add(uid);
  const run: LdapSyncRun = {
    id: newId(),
    runMode: mode,
    status: 'success',
    startedAt,
    endedAt: now(),
    scanned: DEMO_LDAP_PEOPLE.length,
    created: fresh.length,
    updated: 0,
    disabled: 0,
    error: null,
  };
  state.runs.unshift(run);
  return run;
}

export function registerLdapRoutes(backend: MockBackend): void {
  /** the demo's active sign-in method (`setDemoSso`) */
  const ssoMethod = () => demoSsoOptions(backend).method;

  backend.on('GET', '/ldap/config', () => {
    const { tenant } = backend.requireScope('ldap:manage');
    return view(stateOf(backend, tenant.id));
  });

  backend.on('PUT', '/ldap/config', ({ body }) => {
    const { tenant } = backend.requireScope('ldap:manage');
    const state = stateOf(backend, tenant.id);
    apply(state, ssoMethod, body);
    return view(state);
  });

  backend.on('POST', '/ldap/test-connection', () => {
    const { tenant } = backend.requireScope('ldap:manage');
    const state = stateOf(backend, tenant.id);
    if (!state.config.connectionUrl) {
      throw new HttpError(
        400,
        'ldap_config_missing',
        'Save the LDAP settings before testing the connection.',
      );
    }
    if (state.config.bindingAdminDn && !state.passwordSet) {
      throw new HttpError(
        400,
        'ldap_connection_failed',
        "Couldn't connect to the directory: The bind password is missing. Save it in the LDAP settings.",
      );
    }
    return { ok: true };
  });

  backend.on('GET', '/ldap/sync', () => {
    const { tenant } = backend.requireScope('ldap:sync');
    return copy(stateOf(backend, tenant.id).runs);
  });

  backend.on('POST', '/ldap/sync', ({ body }) => {
    const { tenant } = backend.requireScope('ldap:sync');
    const state = stateOf(backend, tenant.id);
    const mode = body.type === 'dry' ? 'dry' : 'live';
    if (body.type !== undefined && body.type !== 'dry' && body.type !== 'live') throw bad('Invalid type');
    if (!runnable(state.config)) {
      throw new HttpError(400, 'ldap_config_missing', 'Save the LDAP settings before running a sync.');
    }
    return finish(state, mode);
  });
}
