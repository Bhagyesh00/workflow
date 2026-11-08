/**
 * MCP settings of a workspace (P5-04, filled by L8): access on or off (`MCP_MANAGED_BY_ENV` makes the
 * PATCH 409 and uses `MCP_ACCESS_ENABLED`), the user's own MCP key (label `MCP Server API Key`,
 * audience `mcp-server-api`, shown once on create and rotate, then `wfk_<prefix>_...`), the workflows
 * an editor can expose and the admin's `toggle-access` (`workflowIds` max 100, `folderId`, `allWorkflows`).
 * Built by routes/mcp-settings.ts from the context; the constructor does no work.
 */
import type { ServerContext } from '../../context';
import type { AuthContext } from '../../http/auth';

export interface McpSettingsDTO {
  mcpAccessEnabled: boolean;
  /** set by the environment (`MCP_MANAGED_BY_ENV`): the page shows it read only */
  managedByEnv: boolean;
  autoExposeNewWorkflows: boolean;
}

export interface McpSettingsPatch {
  mcpAccessEnabled?: boolean;
  autoExposeNewWorkflows?: boolean;
}

export interface McpApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  /** the whole key, only in the reply that created it; else `wfk_<prefix>_...` */
  key: string;
  /** true when `key` is the whole key, shown this once */
  revealed: boolean;
  createdAt: string;
}

export interface McpToggleAccessInput {
  availableInMCP: boolean;
  workflowIds?: string[];
  folderId?: string;
  allWorkflows?: boolean;
}

export class McpSettingsService {
  constructor(readonly ctx: ServerContext) {}

  async getSettings(_auth: AuthContext): Promise<McpSettingsDTO> {
    throw new Error('not implemented (L8)');
  }

  async patchSettings(_auth: AuthContext, _patch: McpSettingsPatch): Promise<McpSettingsDTO> {
    throw new Error('not implemented (L8)');
  }

  /** the caller's own key; creates it (shown once) when none exists */
  async getApiKey(_auth: AuthContext): Promise<McpApiKeyDTO> {
    throw new Error('not implemented (L8)');
  }

  /** replaces the caller's key and shows the new one once */
  async rotateApiKey(_auth: AuthContext): Promise<McpApiKeyDTO> {
    throw new Error('not implemented (L8)');
  }

  /** the workflows the caller can edit, with their `availableInMCP` flag */
  async listWorkflows(_auth: AuthContext, _query: unknown): Promise<unknown> {
    throw new Error('not implemented (L8)');
  }

  /** sets `availableInMCP` on the named workflows, a folder's or all; returns how many changed */
  async toggleAccess(_auth: AuthContext, _input: McpToggleAccessInput): Promise<{ updated: number }> {
    throw new Error('not implemented (L8)');
  }
}
