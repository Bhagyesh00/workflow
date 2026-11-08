/**
 * The workspace's MCP server connections for the Assistant (P5-72). A row holds a credential id, never
 * a secret. Every query names the tenant; an id from a URL is checked with `isUuid`, so a bad id is
 * simply not found.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { assistantMcpConnections } from '../db/schema';
import { isUuid, now } from './util';

export type AssistantMcpConnectionRow = typeof assistantMcpConnections.$inferSelect;

/** the fields an admin may set; `tool_permissions` may only tighten the workspace's MCP permissions */
export type AssistantMcpConnectionInput = Pick<AssistantMcpConnectionRow, 'name' | 'url'> &
  Partial<
    Pick<
      AssistantMcpConnectionRow,
      'transport' | 'authentication' | 'credentialId' | 'enabled' | 'toolPermissions'
    >
  >;

export class AssistantMcpRepository {
  constructor(readonly db: DbOrTx) {}

  /** the tenant's connections by name */
  async list(tenantId: string): Promise<AssistantMcpConnectionRow[]> {
    return this.db
      .select()
      .from(assistantMcpConnections)
      .where(eq(assistantMcpConnections.tenantId, tenantId))
      .orderBy(asc(assistantMcpConnections.name), asc(assistantMcpConnections.id));
  }

  async get(tenantId: string, id: string): Promise<AssistantMcpConnectionRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(assistantMcpConnections)
      .where(and(eq(assistantMcpConnections.tenantId, tenantId), eq(assistantMcpConnections.id, id)));
    return row;
  }

  /** throws a unique violation when the tenant has a connection of that name */
  async create(
    tenantId: string,
    input: AssistantMcpConnectionInput,
    createdBy: string | null,
  ): Promise<AssistantMcpConnectionRow> {
    const [row] = await this.db
      .insert(assistantMcpConnections)
      .values({ ...input, tenantId, createdBy })
      .returning();
    return row;
  }

  /** the row after the change, or undefined when it is not the tenant's */
  async update(
    tenantId: string,
    id: string,
    patch: Partial<AssistantMcpConnectionInput>,
  ): Promise<AssistantMcpConnectionRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(assistantMcpConnections)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(assistantMcpConnections.tenantId, tenantId), eq(assistantMcpConnections.id, id)))
      .returning();
    return row;
  }

  /** true when there was one */
  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(assistantMcpConnections)
      .where(and(eq(assistantMcpConnections.tenantId, tenantId), eq(assistantMcpConnections.id, id)))
      .returning({ id: assistantMcpConnections.id });
    return rows.length > 0;
  }
}
