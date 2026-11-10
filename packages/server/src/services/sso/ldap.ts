/**
 * P6-12 (L10): LDAP sign-in and sync per workspace. `loginWithDirectory` (the first sign-in step,
 * `AuthService.login` through `directoryLogin`) binds the admin, searches, binds as the user and returns a
 * `DirectoryMatch`, never a session: the login then runs the MFA step and `ssoLogin.signIn(...,
 * { authMethod: 'ldap' })`. The sync (leader sweep, `startSweep`, `stopSweep`) creates, updates, disables
 * and enables members of that workspace only, with one history row per run. The user's password is never
 * stored or logged.
 * Stub from C0: `loginWithDirectory` PASSES (undefined: no workspace signs in through a directory, so the
 * password check runs as today), `startSweep` and `stopSweep` PASS (no timer); the rest throws until L10.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthProviderSyncHistoryRow } from '../../db/schema';
import type { DirectoryMatch, LoginInput, SessionMeta } from '../auth';

export type LdapSyncMode = 'live' | 'dry';

export class LdapService {
  constructor(readonly deps: ServiceDeps) {}

  /** Stub (L10) PASSES: undefined, the sign-in goes on with the password */
  async loginWithDirectory(_input: LoginInput, _meta: SessionMeta): Promise<DirectoryMatch | undefined> {
    return undefined;
  }

  /** the leader's sync sweep (finds workspaces that are due). Stub (L10) PASSES: no timer */
  startSweep(): void {
    // stub (L10): PASSES
  }

  /** stops the sweep and waits for nothing. Stub (L10) PASSES */
  stopSweep(): void {
    // stub (L10): PASSES
  }

  /** one sync of a workspace; `dry` writes nothing but the history row */
  async sync(
    _tenantId: string,
    _mode: LdapSyncMode,
    _actorId: string | null,
  ): Promise<AuthProviderSyncHistoryRow> {
    throw new Error('not implemented (L10)');
  }

  /** POST /rest/ldap/test-connection: binds the admin with the saved config */
  async testConnection(_tenantId: string): Promise<{ ok: true }> {
    throw new Error('not implemented (L10)');
  }

  /** GET /rest/ldap/config: the config with the bind password blanked */
  async getConfig(_tenantId: string): Promise<DataObject> {
    throw new Error('not implemented (L10)');
  }

  /** PUT /rest/ldap/config; also the public `PUT /settings/ldap`; audit `ldap.config_updated` */
  async saveConfig(_tenantId: string, _input: DataObject, _actorId: string | null): Promise<DataObject> {
    throw new Error('not implemented (L10)');
  }

  /** `ldap:reset`: clears the config and identities, the method back to email */
  async reset(_tenantId: string): Promise<void> {
    throw new Error('not implemented (L10)');
  }
}
