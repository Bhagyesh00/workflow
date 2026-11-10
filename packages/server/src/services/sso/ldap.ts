/**
 * P6-12 (L10): LDAP sign-in and sync per workspace. `loginWithDirectory` (the first sign-in step,
 * `AuthService.login` through `directoryLogin`) binds the admin, searches, binds as the user and returns a
 * `DirectoryMatch`, never a session: the login then runs the MFA step and `ssoLogin.signIn(...,
 * { authMethod: 'ldap' })`, which holds the account rules (Q-A2: a current member or a pending invitation
 * of this workspace links; a user is created only when the email has no account anywhere, with a personal
 * project in the same transaction as the membership). The sync (leader sweep, `startSweep`, `stopSweep`)
 * creates, updates, disables and enables members of that workspace only, with one history row per run.
 *
 * The user's password is used for one bind and is never stored, logged or audited; the bind password of the
 * admin account is encrypted with a binding to the workspace and blank on read. Filter values are escaped
 * (RFC 4515) and the attribute names of the config are checked before they enter a filter. Every connection
 * goes through the SSRF guard (services/sso/ldap-directory.ts). A directory that does not answer in time ends
 * the login step with no match, so the password path (owners) is still open.
 */
import net from 'node:net';
import { REDACTED } from '@workflow/core';
import { type DataObject, redactSecrets } from '@workflow/workflow';
import { z } from 'zod';
import type { ServiceDeps } from '../../context';
import type { AuthProviderSyncHistoryRow, TenantAuthSettingsRow, UserRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { createRepositories } from '../../repositories';
import { type DirectoryMatch, type LoginInput, randomToken, type SessionMeta } from '../auth';
import { disableMember, enableMember } from '../member-disable';
import {
  type LdapConnectionOptions,
  type LdapDirectory,
  type LdapEntry,
  openLdapDirectory,
} from './ldap-directory';
import type { SsoProfile } from './login';
import { hasSavedConfig, isSsoMethod } from './settings';

export type LdapSyncMode = 'live' | 'dry';

/** the binding of the encrypted bind password (CredentialCipher) */
const BIND_BINDING_ID = 'sso:ldap:bind';
/** the leader checks every minute which workspaces are due */
export const LDAP_SWEEP_INTERVAL_MS = 60_000;
/** one login step may take this long, then the password path goes on */
const LOGIN_BUDGET_MS = 15_000;
const TEST_BUDGET_MS = 20_000;
/** a whole sync may take this long; a `running` row older than twice this is an interrupted run */
const SYNC_BUDGET_MS = 5 * 60_000;
const DEFAULT_SEARCH_TIMEOUT_S = 60;
const MAX_DIRECTORY_ERROR_LENGTH = 300;
const MAX_LOGIN_ID_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const PROVIDER_TYPE = 'ldap';

export type LdapSecurity = 'none' | 'tls' | 'startTls';

/** the `tenant_auth_settings.ldap` object, with n8n's defaults for what was never saved */
interface LdapSettings {
  loginLabel: string;
  connectionUrl: string;
  connectionSecurity: LdapSecurity;
  connectionPort: number;
  allowUnauthorizedCerts: boolean;
  baseDn: string;
  bindingAdminDn: string;
  firstNameAttribute: string;
  lastNameAttribute: string;
  emailAttribute: string;
  loginIdAttribute: string;
  ldapIdAttribute: string;
  userFilter: string;
  synchronizationEnabled: boolean;
  /** minutes */
  synchronizationInterval: number;
  searchPageSize: number;
  /** seconds */
  searchTimeout: number;
  enforceEmailUniqueness: boolean;
  linkExistingAccountsByEmail: boolean;
}

export const LDAP_DEFAULTS: LdapSettings = {
  loginLabel: '',
  connectionUrl: '',
  connectionSecurity: 'none',
  connectionPort: 389,
  allowUnauthorizedCerts: false,
  baseDn: '',
  bindingAdminDn: '',
  firstNameAttribute: '',
  lastNameAttribute: '',
  emailAttribute: '',
  loginIdAttribute: '',
  ldapIdAttribute: '',
  userFilter: '',
  synchronizationEnabled: false,
  synchronizationInterval: 60,
  searchPageSize: 0,
  searchTimeout: DEFAULT_SEARCH_TIMEOUT_S,
  enforceEmailUniqueness: true,
  linkExistingAccountsByEmail: false,
};

/** an attribute name (`mail`, `uid`, `userPrincipalName`, `name;lang-de`) or an OID; or empty */
const ATTRIBUTE = /^$|^[A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*$|^\d+(\.\d+)+$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const attribute = z
  .string()
  .trim()
  .max(128)
  .regex(ATTRIBUTE, 'must be an attribute name, such as mail or uid');
const text = (max: number) => z.string().trim().max(max);

/** the filter must be one parenthesised expression with balanced parentheses (or empty) */
function filterShape(value: string): boolean {
  if (!value) return true;
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      i++;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth < 0 || (depth === 0 && i < value.length - 1)) return false;
    }
  }
  return depth === 0;
}

const configInput = z.object({
  loginEnabled: z.boolean().optional(),
  loginLabel: text(128).optional(),
  connectionUrl: text(253)
    .refine((v) => v === '' || net.isIP(v.replace(/^\[|\]$/g, '')) !== 0 || HOST.test(v), {
      message: 'must be a host name or address without ldap:// or a port',
    })
    .optional(),
  connectionSecurity: z.enum(['none', 'tls', 'startTls']).optional(),
  connectionPort: z.number().int().min(1).max(65535).optional(),
  allowUnauthorizedCerts: z.boolean().optional(),
  baseDn: text(1024).optional(),
  bindingAdminDn: text(1024).optional(),
  bindingAdminPassword: z.string().max(1024).optional(),
  firstNameAttribute: attribute.optional(),
  lastNameAttribute: attribute.optional(),
  emailAttribute: attribute.optional(),
  loginIdAttribute: attribute.optional(),
  ldapIdAttribute: attribute.optional(),
  userFilter: text(1024)
    .refine(filterShape, { message: 'must be one filter in parentheses, such as (objectClass=person)' })
    .optional(),
  synchronizationEnabled: z.boolean().optional(),
  synchronizationInterval: z.number().int().min(1).max(10_080).optional(),
  searchPageSize: z.number().int().min(0).max(100_000).optional(),
  searchTimeout: z.number().int().min(0).max(3600).optional(),
  enforceEmailUniqueness: z.boolean().optional(),
  linkExistingAccountsByEmail: z.boolean().optional(),
});
type ConfigInput = z.infer<typeof configInput>;

/** the fields a login or a sync cannot work without */
const REQUIRED_TO_RUN: Array<[keyof LdapSettings, string]> = [
  ['connectionUrl', 'The server address'],
  ['baseDn', 'The base DN'],
  ['emailAttribute', 'The email attribute'],
  ['loginIdAttribute', 'The login ID attribute'],
  ['ldapIdAttribute', 'The LDAP ID attribute'],
];

/** RFC 4515: a value in a filter never carries filter syntax */
export function escapeLdapFilterValue(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    out +=
      code === 92 || code === 42 || code === 40 || code === 41 || code === 0
        ? `\\${code.toString(16).padStart(2, '0')}`
        : char;
  }
  return out;
}

/** one sync run as the API answers it (`LdapSyncRun`) */
export function syncRunDto(row: AuthProviderSyncHistoryRow): DataObject {
  return {
    id: row.id,
    runMode: row.runMode === 'dry' ? 'dry' : 'live',
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    scanned: row.scanned,
    created: row.created,
    updated: row.updated,
    disabled: row.disabled,
    error: row.error,
  };
}

function readSettings(row: TenantAuthSettingsRow | undefined): LdapSettings {
  const stored = (row?.ldap ?? {}) as Record<string, unknown>;
  const str = <K extends keyof LdapSettings>(key: K): string =>
    typeof stored[key] === 'string' ? (stored[key] as string) : (LDAP_DEFAULTS[key] as string);
  const num = <K extends keyof LdapSettings>(key: K): number =>
    typeof stored[key] === 'number' && Number.isFinite(stored[key])
      ? (stored[key] as number)
      : (LDAP_DEFAULTS[key] as number);
  const bool = <K extends keyof LdapSettings>(key: K): boolean =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : (LDAP_DEFAULTS[key] as boolean);
  const security = stored.connectionSecurity;
  return {
    loginLabel: str('loginLabel'),
    connectionUrl: str('connectionUrl'),
    connectionSecurity: security === 'tls' || security === 'startTls' ? security : 'none',
    connectionPort: num('connectionPort'),
    allowUnauthorizedCerts: bool('allowUnauthorizedCerts'),
    baseDn: str('baseDn'),
    bindingAdminDn: str('bindingAdminDn'),
    firstNameAttribute: str('firstNameAttribute'),
    lastNameAttribute: str('lastNameAttribute'),
    emailAttribute: str('emailAttribute'),
    loginIdAttribute: str('loginIdAttribute'),
    ldapIdAttribute: str('ldapIdAttribute'),
    userFilter: str('userFilter'),
    synchronizationEnabled: bool('synchronizationEnabled'),
    synchronizationInterval: num('synchronizationInterval'),
    searchPageSize: num('searchPageSize'),
    searchTimeout: num('searchTimeout'),
    enforceEmailUniqueness: bool('enforceEmailUniqueness'),
    linkExistingAccountsByEmail: bool('linkExistingAccountsByEmail'),
  };
}

/** the config can sign people in or sync (what `REQUIRED_TO_RUN` lists) */
function runnable(settings: LdapSettings): boolean {
  return REQUIRED_TO_RUN.every(([key]) => String(settings[key]).trim().length > 0);
}

/** an attribute of an entry by name, any case; `dn` is the entry's DN */
function attributeOf(entry: LdapEntry, name: string): string {
  if (!name) return '';
  if (name.toLowerCase() === 'dn') return entry.dn.trim();
  const key = Object.keys(entry.attributes).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = key === undefined ? undefined : entry.attributes[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;

function requestedAttributes(settings: LdapSettings): string[] {
  const names = [
    settings.loginIdAttribute,
    settings.ldapIdAttribute,
    settings.emailAttribute,
    settings.firstNameAttribute,
    settings.lastNameAttribute,
  ].filter((name) => name && name.toLowerCase() !== 'dn');
  return [...new Set(names)];
}

function entryName(entry: LdapEntry, settings: LdapSettings, email: string): string {
  const name = [
    attributeOf(entry, settings.firstNameAttribute),
    attributeOf(entry, settings.lastNameAttribute),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_NAME_LENGTH);
  return name || email.split('@')[0];
}

/** the text of a directory failure for the admin: no password, no stack, a fixed size */
function directoryReason(error: unknown, secrets: Array<string | null> = []): string {
  if (error instanceof LdapTimeoutError) return "The directory didn't answer in time";
  const name = error instanceof Error ? error.name : '';
  if (name === 'InvalidCredentialsError') return 'The bind DN or the bind password was refused';
  if (name === 'NoSuchObjectError') return 'The base DN does not exist in the directory';
  let message = error instanceof Error ? error.message : 'unknown error';
  // a directory's text never carries our bind password, but if one did it would not reach the admin
  for (const secret of secrets) if (secret) message = message.split(secret).join('***');
  return (
    redactSecrets(message).replace(/\s+/g, ' ').trim().slice(0, MAX_DIRECTORY_ERROR_LENGTH) || 'unknown error'
  );
}

class LdapTimeoutError extends Error {
  constructor() {
    super('The directory did not answer in time');
    this.name = 'LdapTimeoutError';
  }
}

/** a run that cannot start or must not go on; the text is the admin's */
class LdapRunError extends Error {}

interface SyncCounts {
  scanned: number;
  created: number;
  updated: number;
  disabled: number;
}

/** a person of the directory with what a workspace needs */
interface DirectoryPerson {
  ldapId: string;
  email: string;
  name: string;
}

export class LdapService {
  /** the seam tests replace: opens a connection to the directory (default: ldapts through the SSRF guard) */
  openDirectory: (options: LdapConnectionOptions) => Promise<LdapDirectory>;

  /** how long a login step, a connection test and a sync may take (ms); tests shorten them */
  readonly budgets = { login: LOGIN_BUDGET_MS, test: TEST_BUDGET_MS, sync: SYNC_BUDGET_MS };

  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  /** workspaces with a sync in flight on this process */
  private readonly running = new Set<string>();

  constructor(readonly deps: ServiceDeps) {
    this.openDirectory = (options) =>
      openLdapDirectory(options, (host) => this.deps.context().http.resolveAllowedHost(host));
  }

  private get ctx() {
    return this.deps.context();
  }

  // ---------------------------------------------------------------------------------------- sign-in

  /**
   * The first sign-in step. A match needs the workspace (`input.workspace`) to use LDAP, a directory entry
   * for the login id and a successful bind as that entry with the given password; anything else is no match
   * (undefined) and the password path goes on. An empty password never reaches the directory: a simple
   * bind with no password is an anonymous bind that succeeds.
   */
  async loginWithDirectory(input: LoginInput, _meta: SessionMeta): Promise<DirectoryMatch | undefined> {
    const slug = input.workspace?.trim();
    const loginId = input.email?.trim() ?? '';
    const password = input.password ?? '';
    if (!slug || !loginId || !password) return undefined;
    if (loginId.length > MAX_LOGIN_ID_LENGTH || password.length > MAX_PASSWORD_LENGTH) return undefined;
    const { repos } = this.deps;
    const tenant = await repos.tenants.getBySlug(slug);
    if (!tenant) return undefined;
    const row = await repos.sso.get(tenant.id);
    if (row?.method !== 'ldap') return undefined;
    const settings = readSettings(row);
    if (!runnable(settings)) return undefined;
    const adminPassword = this.adminPassword(tenant.id, row);

    let entry: LdapEntry | undefined;
    try {
      entry = await this.withDirectory(settings, this.budgets.login, async (directory) => {
        await this.bindAdmin(directory, settings, adminPassword);
        const found = await directory.search({
          baseDn: settings.baseDn,
          filter: this.loginFilter(settings, loginId),
          attributes: requestedAttributes(settings),
          pageSize: 0,
          timeoutMs: this.operationTimeout(settings, this.budgets.login),
        });
        // two entries for one login id: nobody signs in with it
        if (found.length !== 1) return undefined;
        await directory.bind(found[0].dn, password);
        return found[0];
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'InvalidCredentialsError')) {
        this.deps.logger.warn(
          { tenantId: tenant.id, reason: error instanceof Error ? error.name : 'error' },
          'LDAP sign-in step failed',
        );
      }
      return undefined;
    }
    if (!entry) return undefined;

    const email = attributeOf(entry, settings.emailAttribute).toLowerCase();
    const providerId = attributeOf(entry, settings.ldapIdAttribute);
    const profile: SsoProfile = {
      providerType: 'ldap',
      providerId,
      email,
      ...(settings.firstNameAttribute ? { firstName: attributeOf(entry, settings.firstNameAttribute) } : {}),
      ...(settings.lastNameAttribute ? { lastName: attributeOf(entry, settings.lastNameAttribute) } : {}),
      claims: this.claims(entry, settings),
    };

    let user: UserRow | null = null;
    const identity = providerId ? await repos.sso.getIdentity(tenant.id, 'ldap', providerId) : undefined;
    if (identity) {
      user = (await repos.users.get(identity.userId)) ?? null;
    } else if (EMAIL_SHAPE.test(email)) {
      const byEmail = await repos.users.getByEmail(email);
      if (byEmail) {
        // linking an account that exists by its email is the admin's choice; it can only narrow Q-A2
        if (!settings.linkExistingAccountsByEmail) {
          throw new ApiError(
            403,
            'ldap_link_disabled',
            'This email already has an account. Ask an admin of the workspace to turn on linking existing accounts by email.',
          );
        }
        user = byEmail;
      }
    }
    return { tenant, profile, user };
  }

  /** every requested attribute of the entry, as the provisioning reads claims */
  private claims(entry: LdapEntry, settings: LdapSettings): DataObject {
    const claims: DataObject = {};
    for (const name of requestedAttributes(settings)) {
      const key = Object.keys(entry.attributes).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      if (key !== undefined) claims[name] = entry.attributes[key];
    }
    return claims;
  }

  private loginFilter(settings: LdapSettings, loginId: string): string {
    const match = `(${settings.loginIdAttribute}=${escapeLdapFilterValue(loginId)})`;
    return settings.userFilter ? `(&${match}${settings.userFilter})` : match;
  }

  // ------------------------------------------------------------------------------------------ sweep

  /** the leader's sync sweep (finds workspaces that are due) */
  startSweep(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDue().catch((error) => {
        this.deps.logger.warn({ reason: error instanceof Error ? error.name : 'error' }, 'LDAP sweep failed');
      });
    }, LDAP_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /** stops the sweep and waits for nothing */
  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass of the sweep: runs a live sync for every workspace whose sync is on and whose last run is older
   * than its interval. Returns how many syncs ran. A run that failed counts as a run (the interval applies).
   */
  async runDue(now: Date = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let ran = 0;
    try {
      const { ldapHistory } = this.deps.repos;
      await ldapHistory.failStale(new Date(now.getTime() - 2 * SYNC_BUDGET_MS));
      for (const due of await ldapHistory.dueTenants()) {
        const latest = await ldapHistory.latest(due.tenantId, PROVIDER_TYPE);
        const wait = Math.max(1, due.intervalMinutes) * 60_000;
        if (latest && now.getTime() - latest.startedAt.getTime() < wait) continue;
        try {
          await this.sync(due.tenantId, 'live', null);
          ran++;
        } catch (error) {
          this.deps.logger.warn(
            { tenantId: due.tenantId, reason: error instanceof ApiError ? error.code : 'error' },
            'LDAP scheduled sync did not start',
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
    return ran;
  }

  // ------------------------------------------------------------------------------------------ sync

  /**
   * One sync of a workspace; `dry` writes nothing but the history row. 400 when the config is missing, 409
   * while another run of the workspace is in flight. A run that fails is a history row with status `error`
   * and the reason (the row is the answer, not an exception).
   */
  async sync(
    tenantId: string,
    mode: LdapSyncMode,
    actorId: string | null,
  ): Promise<AuthProviderSyncHistoryRow> {
    const { repos } = this.deps;
    // checked and taken before the first await, so two calls at once cannot both start
    if (this.running.has(tenantId)) throw ApiError.conflict('A sync is already running');
    this.running.add(tenantId);
    try {
      const row = await repos.sso.get(tenantId);
      const settings = readSettings(row);
      if (!row || !runnable(settings)) {
        throw new ApiError(400, 'ldap_config_missing', 'Save the LDAP settings before running a sync.');
      }
      const latest = await repos.ldapHistory.latest(tenantId, PROVIDER_TYPE);
      if (latest?.status === 'running' && Date.now() - latest.startedAt.getTime() < 2 * SYNC_BUDGET_MS) {
        throw ApiError.conflict('A sync is already running');
      }
      const started = await repos.ldapHistory.start(tenantId, { providerType: PROVIDER_TYPE, runMode: mode });
      const counts: SyncCounts = { scanned: 0, created: 0, updated: 0, disabled: 0 };
      let status = 'success';
      let error: string | null = null;
      try {
        const secret = this.adminPassword(tenantId, row);
        const failures = await this.runSync(tenantId, mode, settings, secret, counts);
        if (failures > 0) {
          status = 'error';
          error = `${failures} ${failures === 1 ? 'entry' : 'entries'} could not be applied`;
        }
      } catch (caught) {
        status = 'error';
        error =
          caught instanceof LdapRunError
            ? caught.message
            : `Couldn't sync: ${directoryReason(caught, [this.adminPassword(tenantId, row)])}`;
      }
      await repos.ldapHistory.finish(tenantId, started.id, { ...counts, status, error });
      await repos.audit.add(tenantId, {
        userId: actorId,
        action: 'ldap.synced',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { mode, status, ...counts },
      });
      return (await repos.ldapHistory.get(tenantId, started.id)) ?? started;
    } finally {
      this.running.delete(tenantId);
    }
  }

  /** the scan and the changes; the number of entries that could not be applied */
  private async runSync(
    tenantId: string,
    mode: LdapSyncMode,
    settings: LdapSettings,
    adminPassword: string | null,
    counts: SyncCounts,
  ): Promise<number> {
    const { repos } = this.deps;
    const entries = await this.withDirectory(settings, this.budgets.sync, async (directory) => {
      await this.bindAdmin(directory, settings, adminPassword);
      return directory.search({
        baseDn: settings.baseDn,
        filter: settings.userFilter || '(objectClass=*)',
        attributes: requestedAttributes(settings),
        pageSize: settings.searchPageSize,
        timeoutMs: this.operationTimeout(settings, this.budgets.sync),
      });
    });
    counts.scanned = entries.length;
    const identities = await repos.ldapHistory.identities(tenantId);
    if (entries.length === 0 && identities.length > 0) {
      throw new LdapRunError(
        'The directory returned no users, so nobody was changed. Check the base DN and the user filter.',
      );
    }

    const seenIds = new Set<string>();
    const byEmail = new Map<string, DirectoryPerson[]>();
    const byId = new Map<string, DirectoryPerson>();
    for (const entry of entries) {
      const ldapId = attributeOf(entry, settings.ldapIdAttribute);
      if (ldapId) seenIds.add(ldapId);
      const email = attributeOf(entry, settings.emailAttribute).toLowerCase();
      if (!ldapId || !EMAIL_SHAPE.test(email) || email.length > 254 || byId.has(ldapId)) continue;
      const person = { ldapId, email, name: entryName(entry, settings, email) };
      byId.set(ldapId, person);
      byEmail.set(email, [...(byEmail.get(email) ?? []), person]);
    }
    // two entries with one email never make two accounts: with uniqueness enforced neither is touched, else
    // the first one in the directory's order is
    const people: DirectoryPerson[] = [];
    for (const group of byEmail.values()) {
      if (group.length === 1) people.push(group[0]);
      else if (!settings.enforceEmailUniqueness) people.push(group[0]);
      else for (const skipped of group) seenIds.add(skipped.ldapId);
    }

    const known = new Map(identities.map((identity) => [identity.providerId, identity]));
    let failures = 0;
    for (const person of people) {
      try {
        await this.applyPerson(tenantId, mode, settings, person, known.get(person.ldapId), counts);
      } catch (error) {
        failures++;
        this.deps.logger.warn(
          { tenantId, reason: error instanceof ApiError ? error.code : 'error' },
          'LDAP sync could not apply an entry',
        );
      }
    }
    for (const identity of identities) {
      if (seenIds.has(identity.providerId) || identity.disabled) continue;
      try {
        if (mode === 'live') {
          if (!(await disableMember(this.ctx, tenantId, identity.userId, null))) continue;
        }
        counts.disabled++;
      } catch (error) {
        // an owner stays; a member removed meanwhile is gone
        if (!(error instanceof ApiError && (error.statusCode === 403 || error.statusCode === 404)))
          failures++;
      }
    }
    return failures;
  }

  private async applyPerson(
    tenantId: string,
    mode: LdapSyncMode,
    settings: LdapSettings,
    person: DirectoryPerson,
    identity: { userId: string; disabled: boolean } | undefined,
    counts: SyncCounts,
  ): Promise<void> {
    const { repos } = this.deps;
    const ctx = this.ctx;
    if (identity) {
      let changed = false;
      if (identity.disabled) {
        if (mode === 'live') await enableMember(ctx, tenantId, identity.userId, null);
        changed = true;
      }
      const user = await repos.users.get(identity.userId);
      if (
        user &&
        person.name &&
        person.name !== user.name &&
        (await repos.sso.otherMembershipCount(user.id, tenantId)) === 0
      ) {
        if (mode === 'live') await repos.users.updateName(user.id, person.name);
        changed = true;
      }
      if (changed) counts.updated++;
      return;
    }

    const existing = await repos.users.getByEmail(person.email);
    if (existing) {
      // another workspace's account, or a person nobody here knows: only a current member links, and only
      // when the admin allows linking by email (decision Q-A2)
      const membership = await repos.memberships.getIncludingDisabled(tenantId, existing.id);
      if (!membership || !settings.linkExistingAccountsByEmail) return;
      if (mode === 'live') {
        await repos.sso.linkIdentity(tenantId, {
          providerType: PROVIDER_TYPE,
          providerId: person.ldapId,
          userId: existing.id,
        });
      }
      counts.updated++;
      return;
    }
    // a pending invitation joins at the person's first sign-in (SsoLoginService.signIn accepts it)
    if (await repos.sso.pendingInvitation(tenantId, person.email)) return;
    if (mode === 'live') {
      const passwordHash = await ctx.auth.hashPassword(randomToken(32));
      await this.deps.database.db.transaction(async (tx) => {
        const txRepos = createRepositories(tx);
        const user = await txRepos.users.create({ email: person.email, name: person.name, passwordHash });
        await txRepos.memberships.add(tenantId, user.id, 'member');
        // P6-03: every member has a personal project, in the same transaction as the membership
        await txRepos.projects.ensurePersonal(tenantId, user);
        await txRepos.sso.linkIdentity(tenantId, {
          providerType: PROVIDER_TYPE,
          providerId: person.ldapId,
          userId: user.id,
        });
        await txRepos.audit.add(tenantId, {
          userId: user.id,
          action: 'member.joined',
          resourceType: 'user',
          resourceId: user.id,
          metadata: { role: 'member', method: 'ldap', sync: true },
        });
      });
    }
    counts.created++;
  }

  /** one page of the history, newest first; `more` = a further page exists */
  async history(
    tenantId: string,
    options: { take: number; skip: number },
  ): Promise<{ rows: AuthProviderSyncHistoryRow[]; more: boolean }> {
    const rows = await this.deps.repos.ldapHistory.list(tenantId, {
      providerType: PROVIDER_TYPE,
      take: options.take + 1,
      skip: options.skip,
    });
    return { rows: rows.slice(0, options.take), more: rows.length > options.take };
  }

  // ------------------------------------------------------------------------------------ the config

  /** POST /rest/ldap/test-connection: binds the admin with the saved config */
  async testConnection(tenantId: string): Promise<{ ok: true }> {
    const row = await this.deps.repos.sso.get(tenantId);
    const settings = readSettings(row);
    if (!row || !settings.connectionUrl) {
      throw new ApiError(400, 'ldap_config_missing', 'Save the LDAP settings before testing the connection.');
    }
    try {
      await this.withDirectory(settings, this.budgets.test, async (directory) => {
        await this.bindAdmin(directory, settings, this.adminPassword(tenantId, row));
      });
    } catch (error) {
      throw new ApiError(
        400,
        'ldap_connection_failed',
        `Couldn't connect to the directory: ${directoryReason(error, [this.adminPassword(tenantId, row)])}`,
      );
    }
    return { ok: true };
  }

  /** GET /rest/ldap/config: the config with the bind password blanked */
  async getConfig(tenantId: string): Promise<DataObject> {
    const row = await this.deps.repos.sso.get(tenantId);
    return { loginEnabled: row?.method === 'ldap', ...readSettings(row), bindingAdminPassword: '' };
  }

  /** PUT /rest/ldap/config; also the public `PUT /settings/ldap`; audit `ldap.config_updated` */
  async saveConfig(tenantId: string, input: DataObject, actorId: string | null): Promise<DataObject> {
    const parsed = configInput.safeParse(input);
    if (!parsed.success) {
      throw ApiError.badRequest(
        `Invalid LDAP settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}`)
          .join(', ')}`,
      );
    }
    const { loginEnabled, bindingAdminPassword, ...fields } = parsed.data as ConfigInput;
    const row = await this.deps.repos.sso.get(tenantId);
    const next: LdapSettings = { ...readSettings(row) };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (!next.connectionUrl) throw ApiError.badRequest('The server address is required');
    const wantsLogin = loginEnabled ?? row?.method === 'ldap';
    if (wantsLogin || next.synchronizationEnabled) {
      const missing = REQUIRED_TO_RUN.filter(([key]) => !String(next[key]).trim()).map(([, label]) => label);
      if (missing.length)
        throw ApiError.badRequest(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
    }
    // a blank (or the redaction sentinel) keeps the stored bind password
    const given =
      bindingAdminPassword && bindingAdminPassword !== REDACTED ? bindingAdminPassword : undefined;
    const passwordEnc = given
      ? this.ctx.cipher.encrypt(given, { tenantId, credentialId: BIND_BINDING_ID })
      : row?.ldapPasswordEnc;

    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.sso.upsert(tenantId, {
        ldap: next as unknown as Record<string, unknown>,
        ldapPasswordEnc: passwordEnc ?? null,
      });
      if (loginEnabled !== undefined) await this.setLogin(repos, tenantId, loginEnabled, actorId);
      await repos.audit.add(tenantId, {
        userId: actorId,
        action: 'ldap.config_updated',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { passwordChanged: Boolean(given), loginEnabled: loginEnabled ?? null },
      });
    });
    return this.getConfig(tenantId);
  }

  /** the toggle: the same rules as `SsoSettingsService.setMethod` (one method; through email) */
  private async setLogin(
    repos: ReturnType<typeof createRepositories>,
    tenantId: string,
    enabled: boolean,
    actorId: string | null,
  ): Promise<void> {
    const row = await repos.sso.get(tenantId);
    const current = row?.method ?? 'email';
    const target = enabled ? 'ldap' : 'email';
    if (enabled && current === 'ldap') return;
    if (!enabled && current !== 'ldap') return;
    if (enabled && current !== 'email') {
      throw new ApiError(
        400,
        'sso_switch_through_email',
        'Turn the current sign-in method off first. A workspace moves from one sign-in method to another through email sign-in.',
      );
    }
    if (enabled && !hasSavedConfig(row, 'ldap')) {
      throw new ApiError(400, 'sso_config_missing', 'Save the LDAP settings before turning LDAP on.');
    }
    await repos.sso.upsert(tenantId, { method: target });
    if (isSsoMethod(current)) await repos.sso.disableScim(tenantId);
    await repos.audit.add(tenantId, {
      userId: actorId,
      action: 'sso.method_changed',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { from: current, to: target },
    });
  }

  /**
   * `ldap:reset`: clears the config, the identities and the history; the method goes back to email when LDAP
   * was the active one; the sessions of the LDAP users in this workspace end. The members stay (the command
   * moved or deleted their work first).
   */
  async reset(tenantId: string): Promise<void> {
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const row = await repos.sso.get(tenantId);
      for (const identity of await repos.ldapHistory.identities(tenantId)) {
        await repos.sessions.deleteForUserInTenant(tenantId, identity.userId);
      }
      await repos.sso.deleteIdentities(tenantId, 'ldap');
      await repos.sso.upsert(tenantId, {
        ldap: null,
        ldapPasswordEnc: null,
        ...(row?.method === 'ldap' ? { method: 'email' as const } : {}),
      });
      await repos.ldapHistory.deleteForTenant(tenantId, PROVIDER_TYPE);
      await repos.audit.add(tenantId, {
        userId: null,
        action: 'ldap.config_updated',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { reset: true },
      });
    });
  }

  // ------------------------------------------------------------------------------------ the wire

  private adminPassword(tenantId: string, row: TenantAuthSettingsRow): string | null {
    if (!row.ldapPasswordEnc) return null;
    try {
      return this.ctx.cipher.decrypt<string>(row.ldapPasswordEnc, {
        tenantId,
        credentialId: BIND_BINDING_ID,
      });
    } catch {
      return null;
    }
  }

  /** binds the admin account; with no DN the search runs anonymously, an empty password is never sent */
  private async bindAdmin(directory: LdapDirectory, settings: LdapSettings, password: string | null) {
    if (!settings.bindingAdminDn) return;
    if (!password) throw new LdapRunError('The bind password is missing. Save it in the LDAP settings.');
    await directory.bind(settings.bindingAdminDn, password);
  }

  private operationTimeout(settings: LdapSettings, budgetMs: number): number {
    const configured =
      (settings.searchTimeout > 0 ? settings.searchTimeout : DEFAULT_SEARCH_TIMEOUT_S) * 1000;
    return Math.min(configured, budgetMs);
  }

  /** opens the directory, runs the work and always closes; a work that outlives `budgetMs` ends with a timeout */
  private async withDirectory<T>(
    settings: LdapSettings,
    budgetMs: number,
    work: (directory: LdapDirectory) => Promise<T>,
  ): Promise<T> {
    let directory: LdapDirectory | undefined;
    let timer: NodeJS.Timeout | undefined;
    const task = (async () => {
      try {
        directory = await this.openDirectory({
          host: settings.connectionUrl,
          port: settings.connectionPort,
          security: settings.connectionSecurity,
          allowUnauthorizedCerts: settings.allowUnauthorizedCerts,
          timeoutMs: this.operationTimeout(settings, budgetMs),
        });
        return await work(directory);
      } finally {
        await directory?.close().catch(() => undefined);
      }
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void directory?.close().catch(() => undefined);
        reject(new LdapTimeoutError());
      }, budgetMs);
    });
    try {
      return await Promise.race([task, deadline]);
    } finally {
      clearTimeout(timer);
      task.catch(() => undefined);
    }
  }
}
