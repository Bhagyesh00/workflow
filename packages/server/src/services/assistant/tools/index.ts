/**
 * The Assistant's tool list (P5-69, FULL from C0, C0-final). `assistantTools` joins every tool file's
 * array and the service's `extraTools` (the test seam), then drops the tools above the caller's role and
 * those whose permission is `blocked`. The run's `available` check is L1's `toAiTools`, since this
 * function has no run. MCP tools come from `openMcpTools` per turn; an approved MCP call after a stop
 * finds its tool again through `resolveDynamicTool`.
 */
import type { ServerContext } from '../../../context';
import type { Role } from '../../../db/schema';
import { hasRole } from '../../auth';
import { resolveMcpTool } from '../mcp';
import type { AssistantRunScope, AssistantToolDefinition, EffectiveAssistantSettings } from '../types';
import { attachmentsTools } from './attachments';
import { buildTools } from './build';
import { credentialsTools } from './credentials';
import { dataTablesTools } from './data-tables';
import { executionsTools } from './executions';
import { interactionTools } from './interaction';
import { modelsTools } from './models';
import { nodesTools } from './nodes';
import { researchTools } from './research';
import { workflowsTools } from './workflows';
import { workspaceTools } from './workspace';

/** every built-in tool in a fixed order (the model sees this order) */
export function builtInAssistantTools(): AssistantToolDefinition[] {
  return [
    ...workflowsTools,
    ...executionsTools,
    ...dataTablesTools,
    ...workspaceTools,
    ...credentialsTools,
    ...nodesTools,
    ...modelsTools,
    ...interactionTools,
    ...buildTools,
    ...researchTools,
    ...attachmentsTools,
  ];
}

/**
 * The tools `role` may be offered under `settings`: built-in ones, then `extraTools`; a tool above the
 * role or with a `blocked` permission is dropped, and a second tool with a name already taken is dropped
 * (providers refuse a request with a tool name twice).
 */
export function assistantTools(
  role: Role,
  settings: EffectiveAssistantSettings,
  extraTools: AssistantToolDefinition[] = [],
): AssistantToolDefinition[] {
  const seen = new Set<string>();
  const out: AssistantToolDefinition[] = [];
  for (const def of [...builtInAssistantTools(), ...extraTools]) {
    if (!hasRole(role, def.minRole)) continue;
    if (def.permission !== undefined && settings.permissions[def.permission] === 'blocked') continue;
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    out.push(def);
  }
  return out;
}

/**
 * A tool that is not in the fixed list (an MCP server's tool), found again by name for an approved call
 * after a stop; its `close()` runs in the caller's `finally`. Undefined when none matches.
 */
export async function resolveDynamicTool(
  ctx: ServerContext,
  run: AssistantRunScope,
  name: string,
): Promise<{ tool: AssistantToolDefinition; close(): Promise<void> } | undefined> {
  return resolveMcpTool(ctx, run, name);
}
