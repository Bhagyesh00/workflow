/**
 * The MCP build tools (P5-13, filled by L9; research-B part b): node search and details, format
 * reference, validate, create, update, archive, restore a version, explore node resources. L8's
 * tool table spreads this list, so L9 edits no L8 file. Hidden when `MCP_BUILDER_ENABLED` is false.
 * Support tools (search, details, reference, validate) are listed on a read or write scope; the tools that
 * change a workspace need `workflow:write` and the editor role; `explore_node_resources` is `credential:read`.
 */
import type { McpToolDefinition } from '../../types';
import { archiveTools } from './archive';
import { createTools } from './create';
import { formatTools } from './format';
import { nodeTools } from './nodes';
import { resourceTools } from './resources';
import { updateTools } from './update';
import { validateTools } from './validate';

export { assertCredentialsInTenant } from './credential-check';

export const MCP_BUILDER_TOOLS: McpToolDefinition<any>[] = [
  ...nodeTools,
  ...formatTools,
  ...validateTools,
  ...createTools,
  ...updateTools,
  ...archiveTools,
  ...resourceTools,
];
