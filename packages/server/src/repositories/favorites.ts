/**
 * Per-user favorites (P3-07, P4-03): workflows, folders and data tables. Every query filters tenant_id, and the
 * per-user methods filter user_id as well.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { userFavorites } from '../db/schema';
import { isUuid } from './util';

export type FavoriteResourceType = 'workflow' | 'folder' | 'dataTable';

export interface FavoriteRow {
  resourceType: FavoriteResourceType;
  resourceId: string;
  name: string;
  createdAt: Date;
}

export class FavoriteRepository {
  constructor(readonly db: DbOrTx) {}

  /**
   * The user's favorites with the current names, oldest first. Archived workflows and resources
   * that no longer exist are left out.
   */
  async list(tenantId: string, userId: string): Promise<FavoriteRow[]> {
    const result = await this.db.execute<{
      resource_type: FavoriteResourceType;
      resource_id: string;
      name: string;
      created_at: Date;
    }>(sql`
      select f.resource_type, f.resource_id, coalesce(w.name, fo.name, dt.name) as name, f.created_at
      from user_favorites f
      left join workflows w on f.resource_type = 'workflow' and w.id = f.resource_id and w.tenant_id = f.tenant_id
      left join folders fo on f.resource_type = 'folder' and fo.id = f.resource_id and fo.tenant_id = f.tenant_id
      left join data_tables dt on f.resource_type = 'dataTable' and dt.id = f.resource_id and dt.tenant_id = f.tenant_id
      where f.tenant_id = ${tenantId} and f.user_id = ${userId}::uuid
        and ((w.id is not null and not w.is_archived) or fo.id is not null or dt.id is not null)
      order by f.created_at asc, f.resource_id asc`);
    return result.rows.map((r) => ({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      name: r.name,
      createdAt: new Date(r.created_at),
    }));
  }

  /** idempotent; returns the row's creation time */
  async add(tenantId: string, userId: string, type: FavoriteResourceType, resourceId: string): Promise<Date> {
    await this.db
      .insert(userFavorites)
      .values({ tenantId, userId, resourceType: type, resourceId })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ createdAt: userFavorites.createdAt })
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.tenantId, tenantId),
          eq(userFavorites.userId, userId),
          eq(userFavorites.resourceType, type),
          eq(userFavorites.resourceId, resourceId),
        ),
      );
    return row.createdAt;
  }

  async remove(
    tenantId: string,
    userId: string,
    type: FavoriteResourceType,
    resourceId: string,
  ): Promise<void> {
    if (!isUuid(resourceId)) return;
    await this.db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.tenantId, tenantId),
          eq(userFavorites.userId, userId),
          eq(userFavorites.resourceType, type),
          eq(userFavorites.resourceId, resourceId),
        ),
      );
  }

  /** remove every user's favorite of one resource; returns the number removed */
  async removeForResource(tenantId: string, type: FavoriteResourceType, resourceId: string): Promise<number> {
    if (!isUuid(resourceId)) return 0;
    const rows = await this.db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.tenantId, tenantId),
          eq(userFavorites.resourceType, type),
          eq(userFavorites.resourceId, resourceId),
        ),
      )
      .returning({ id: userFavorites.resourceId });
    return rows.length;
  }
}
