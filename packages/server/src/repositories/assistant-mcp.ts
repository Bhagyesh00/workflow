/**
 * The workspace's MCP server connections for the Assistant (P5-72). A row holds a credential id, never
 * a secret. Every query names the tenant. C0 stub with the final signatures; lane L9 writes the bodies.
 */
import type { DbOrTx } from '../db/client';
import type { assistantMcpConnections } from '../db/schema';

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
  async list(_tenantId: string): Promise<AssistantMcpConnectionRow[]> {
    throw new Error('not implemented (L9)');
  }

  async get(_tenantId: string, _id: string): Promise<AssistantMcpConnectionRow | undefined> {
    throw new Error('not implemented (L9)');
  }

  /** throws a unique violation when the tenant has a connection of that name */
  async create(
    _tenantId: string,
    _input: AssistantMcpConnectionInput,
    _createdBy: string | null,
  ): Promise<AssistantMcpConnectionRow> {
    throw new Error('not implemented (L9)');
  }

  /** the row after the change, or undefined when it is not the tenant's */
  async update(
    _tenantId: string,
    _id: string,
    _patch: Partial<AssistantMcpConnectionInput>,
  ): Promise<AssistantMcpConnectionRow | undefined> {
    throw new Error('not implemented (L9)');
  }

  /** true when there was one */
  async delete(_tenantId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L9)');
  }
}
