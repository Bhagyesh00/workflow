/**
 * External secret connections (P4-07) and their project shares (P6-28). Every method takes the tenant
 * first, except the system-level reads the manager's load and refresh use, which say so. `settingsEnc` is ciphertext; only
 * the manager decrypts it.
 */
import { and, asc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  credentials,
  type ProjectRow,
  projectSecretAccess,
  projects,
  type SecretConnectionRow,
  secretConnections,
} from '../db/schema';
import { type AccessListOptions, inUuids } from './shares';
import { isUuid, now } from './util';

export type SecretConnectionInsert = Pick<
  SecretConnectionRow,
  'id' | 'providerKey' | 'type' | 'settingsEnc' | 'isEnabled' | 'createdBy'
> & {
  /** the owning project (P6-28); absent or null = a workspace connection */
  projectId?: string | null;
};

/** P6-28: one `project_secret_access` row with the project it names */
export interface SecretConnectionShare {
  connectionId: string;
  role: string;
  project: Pick<ProjectRow, 'id' | 'name' | 'type' | 'icon'>;
}

/** P6-28: one `project_secret_access` row, system-level (the access list of every process) */
export interface SecretAccessEntry {
  tenantId: string;
  connectionId: string;
  projectId: string;
}

export type SecretConnectionPatch = Partial<
  Pick<SecretConnectionRow, 'type' | 'settingsEnc' | 'isEnabled' | 'state' | 'lastError'>
>;

export class SecretConnectionRepository {
  constructor(readonly db: DbOrTx) {}

  /**
   * With `AccessListOptions` (P6-28): a connection is reached by the project that owns it or a project it
   * is shared with (`project_secret_access`); a workspace connection (no owner) only with `filter.all`
   * or no filter, unless it is shared. `onlySharedWithMe` keeps only shared connections of `projectId`.
   */
  async list(tenantId: string, options: AccessListOptions = {}): Promise<SecretConnectionRow[]> {
    const sharedInto = (projectIds: string[]) =>
      sql`${secretConnections.id} in (select ${projectSecretAccess.connectionId} from ${projectSecretAccess} where ${projectSecretAccess.tenantId} = ${tenantId}::uuid and ${inUuids(projectSecretAccess.projectId, projectIds)})`;
    const conditions: SQL[] = [eq(secretConnections.tenantId, tenantId)];
    const { filter } = options;
    if (filter && !filter.all) {
      const projectIds = [...new Set(filter.projectIds.filter(isUuid))];
      if (!projectIds.length) return [];
      conditions.push(
        sql`(${inUuids(secretConnections.projectId, projectIds)} or ${sharedInto(projectIds)})`,
      );
    }
    if (options.onlySharedWithMe) {
      if (options.projectId === undefined || !isUuid(options.projectId)) return [];
      conditions.push(sharedInto([options.projectId]));
    } else if (options.projectId !== undefined) {
      if (!isUuid(options.projectId)) return [];
      conditions.push(
        sql`(${secretConnections.projectId} = ${options.projectId}::uuid or ${sharedInto([options.projectId])})`,
      );
    }
    return this.db
      .select()
      .from(secretConnections)
      .where(and(...conditions))
      .orderBy(asc(secretConnections.providerKey));
  }

  async get(tenantId: string, providerKey: string): Promise<SecretConnectionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(secretConnections)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)));
    return row;
  }

  async create(tenantId: string, row: SecretConnectionInsert): Promise<SecretConnectionRow> {
    const [created] = await this.db
      .insert(secretConnections)
      .values({ ...row, tenantId, createdAt: now(), updatedAt: now() })
      .returning();
    return created;
  }

  /**
   * `updatedAt` moves only for what an admin changed: other processes compare it to see whether their
   * copy is old, and a state or lastError write of their own must not look like a change.
   */
  async update(
    tenantId: string,
    providerKey: string,
    patch: SecretConnectionPatch,
  ): Promise<SecretConnectionRow | undefined> {
    const changed =
      patch.type !== undefined || patch.settingsEnc !== undefined || patch.isEnabled !== undefined;
    const [row] = await this.db
      .update(secretConnections)
      .set(changed ? { ...patch, updatedAt: now() } : patch)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)))
      .returning();
    return row;
  }

  /** true when a row went */
  async delete(tenantId: string, providerKey: string): Promise<boolean> {
    const rows = await this.db
      .delete(secretConnections)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)))
      .returning({ id: secretConnections.id });
    return rows.length > 0;
  }

  /** the projects a connection is shared with (`project_secret_access`) and the role each holds */
  async accessFor(
    tenantId: string,
    connectionId: string,
  ): Promise<Array<{ projectId: string; role: string }>> {
    if (!isUuid(connectionId)) return [];
    return this.db
      .select({ projectId: projectSecretAccess.projectId, role: projectSecretAccess.role })
      .from(projectSecretAccess)
      .where(
        and(eq(projectSecretAccess.tenantId, tenantId), eq(projectSecretAccess.connectionId, connectionId)),
      );
  }

  /** P6-28: the shares of these connections with their projects, oldest project name first */
  async sharesOf(tenantId: string, connectionIds: string[]): Promise<SecretConnectionShare[]> {
    const ids = [...new Set(connectionIds.filter(isUuid))];
    if (!ids.length) return [];
    return this.db
      .select({
        connectionId: projectSecretAccess.connectionId,
        role: projectSecretAccess.role,
        project: { id: projects.id, name: projects.name, type: projects.type, icon: projects.icon },
      })
      .from(projectSecretAccess)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, projectSecretAccess.tenantId), eq(projects.id, projectSecretAccess.projectId)),
      )
      .where(and(eq(projectSecretAccess.tenantId, tenantId), inArray(projectSecretAccess.connectionId, ids)))
      .orderBy(asc(projects.name), asc(projects.id));
  }

  /**
   * P6-28: the projects a connection is shared with become exactly `projectIds` (role
   * `secretsProviderConnection:user` for new ones; a project that stays keeps its role). One transaction.
   */
  async setShares(tenantId: string, connectionId: string, projectIds: string[]): Promise<void> {
    const wanted = [...new Set(projectIds)];
    await this.db.transaction(async (tx) => {
      const scope = and(eq(projectSecretAccess.tenantId, tenantId), eq(projectSecretAccess.connectionId, connectionId));
      await tx
        .delete(projectSecretAccess)
        .where(wanted.length ? and(scope, notInArray(projectSecretAccess.projectId, wanted)) : scope);
      if (wanted.length) {
        await tx
          .insert(projectSecretAccess)
          .values(wanted.map((projectId) => ({ tenantId, connectionId, projectId })))
          .onConflictDoNothing();
      }
    });
  }

  /**
   * P6-28: the keys of `providerKeys` that a credential of `projectId` may read: a connection the project
   * owns, one shared with it, or a workspace connection shared with no project. Enabled or not.
   */
  async keysReachableFrom(tenantId: string, projectId: string, providerKeys: string[]): Promise<string[]> {
    const keys = [...new Set(providerKeys)];
    if (!keys.length) return [];
    const project = isUuid(projectId) ? sql`${projectId}::uuid` : sql`null::uuid`;
    const rows = await this.db
      .select({ providerKey: secretConnections.providerKey })
      .from(secretConnections)
      .where(
        and(
          eq(secretConnections.tenantId, tenantId),
          inArray(secretConnections.providerKey, keys),
          sql`(${secretConnections.projectId} = ${project}
            or exists (select 1 from ${projectSecretAccess} where ${projectSecretAccess.tenantId} = ${secretConnections.tenantId} and ${projectSecretAccess.connectionId} = ${secretConnections.id} and ${projectSecretAccess.projectId} = ${project})
            or (${secretConnections.projectId} is null and not exists (select 1 from ${projectSecretAccess} where ${projectSecretAccess.tenantId} = ${secretConnections.tenantId} and ${projectSecretAccess.connectionId} = ${secretConnections.id})))`,
        ),
      );
    return rows.map((row) => row.providerKey);
  }

  /** credentials whose secret_keys hold this connection, for the delete warning */
  async countCredentialsUsing(tenantId: string, providerKey: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), sql`${providerKey} = ANY(${credentials.secretKeys})`));
    return row?.count ?? 0;
  }

  /** what a credential refers to; its data and `updatedAt` stay as they are */
  async setCredentialSecretKeys(tenantId: string, credentialId: string, keys: string[]): Promise<void> {
    if (!isUuid(credentialId)) return;
    await this.db
      .update(credentials)
      .set({ secretKeys: keys })
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, credentialId)));
  }

  /** System-level: every tenant's enabled connections, for the load before jobs start. */
  async listAllEnabled(): Promise<SecretConnectionRow[]> {
    return this.db.select().from(secretConnections).where(eq(secretConnections.isEnabled, true));
  }

  /** System-level (P6-28): every share of every enabled connection, for the refresh of the access list. */
  async listAllEnabledShares(): Promise<SecretAccessEntry[]> {
    return this.db
      .select({
        tenantId: projectSecretAccess.tenantId,
        connectionId: projectSecretAccess.connectionId,
        projectId: projectSecretAccess.projectId,
      })
      .from(projectSecretAccess)
      .innerJoin(
        secretConnections,
        and(
          eq(secretConnections.tenantId, projectSecretAccess.tenantId),
          eq(secretConnections.id, projectSecretAccess.connectionId),
        ),
      )
      .where(eq(secretConnections.isEnabled, true));
  }
}
