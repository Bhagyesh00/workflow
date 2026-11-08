/**
 * The workspace's MCP servers as Assistant tools (P5-72, lane L9). Per enabled connection a one-parent
 * definition (`ai.agent`, `ai.mcpClientTool`) is opened through `openSubNodes`, its `ai_tool` read,
 * descriptions and schemas sanitized (mcp-sanitize.ts), names made `mcp_<connection>_<tool>`,
 * `permission` `mcpRead` only for a `readOnlyHint` tool, else `mcpWrite`, `minRole` editor. None when
 * `mcpAccessEnabled` is off or the caller is below editor. One server that cannot be reached gives a
 * status note and the others still work.
 *
 * Everything a server sends is untrusted: results are cleaned here and wrapped by `shapeToolResult`
 * (`untrusted: 'mcp:<connection>'` is `wrapUntrusted`'s source), the credential is read by the MCP
 * Client Tool node itself (so its allowed hosts and the redirect rule apply) and never reaches this file.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiTool,
  type AssistantPermissionKey,
  type AssistantPermissionMode,
  type DataObject,
  latestVersion,
  redactSecrets,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import type { AssistantMcpConnectionRow } from '../../repositories/assistant-mcp';
import { openSubNodes } from '../ai-builder/model';
import { hasRole } from '../auth';
import {
  MCP_LIMITS,
  mcpToolName,
  mcpToolPrefix,
  nameToken,
  sanitizeResultText,
  sanitizeSchema,
  sanitizeToolDescription,
  stripInvisible,
} from './mcp-sanitize';
import { builtInAssistantTools } from './tools';
import type {
  ApprovalCopy,
  AssistantRunScope,
  AssistantToolDefinition,
  EffectiveAssistantSettings,
} from './types';

const AGENT_TYPE = 'ai.agent';
const MCP_TOOL_TYPE = 'ai.mcpClientTool';
const PARENT_NAME = 'Assistant MCP';
const SERVER_NAME = 'MCP server';
/** connect and call timeout of one server, in milliseconds */
const MCP_TIMEOUT_MS = 30_000;

/** `authentication` (the MCP Client node's value) to the credential type that fills its slot */
export const MCP_CREDENTIAL_TYPES: Record<AssistantMcpConnectionRow['authentication'], string | null> = {
  none: null,
  bearerAuth: 'httpBearerAuth',
  headerAuth: 'httpHeaderAuth',
  multipleHeadersAuth: 'httpMultipleHeadersAuth',
  mcpOAuth2Api: 'mcpOAuth2Api',
};

/** the workspace's server addresses: https, or http on a loopback host only (no user info) */
export function validateMcpUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, reason: 'The address is not a valid URL' };
  }
  if (url.username || url.password)
    return { ok: false, reason: 'The address must not hold a user name or password' };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:') {
    const host = url.hostname;
    const loopback = host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
    if (loopback) return { ok: true, url };
    return { ok: false, reason: 'The address must use https (http is only allowed for localhost)' };
  }
  return { ok: false, reason: 'The address must start with https://' };
}

interface OpenedServer {
  defs: AssistantToolDefinition[];
  /** why a tool or the server was left out, for the person (never the model) */
  notes: string[];
  close(): Promise<void>;
}

/** what a tool call of this turn needs from the workspace, read once */
interface Access {
  settings: EffectiveAssistantSettings;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** a server-supplied or error text for a status note: redacted, invisible characters out, short */
function noteText(text: unknown): string {
  const raw = text instanceof Error ? text.message : String(text ?? '');
  return cut(redactSecrets(stripInvisible(raw)).replace(/\s+/g, ' ').trim(), 200);
}

/** the text of a `tools/call` result: text parts kept, other parts named, then cleaned */
function resultText(content: unknown, structured: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content as Array<DataObject & { type?: unknown }>) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (
        part?.type === 'resource' &&
        typeof (part.resource as DataObject | undefined)?.text === 'string'
      ) {
        parts.push(String((part.resource as DataObject).text));
      } else parts.push(`[${String(part?.type ?? 'unknown').replace(/[^\w-]/g, '')} content omitted]`);
    }
  }
  let text = parts.join('\n');
  if (!text && structured !== undefined) {
    try {
      text = JSON.stringify(structured) ?? '';
    } catch {
      text = '';
    }
  }
  return redactSecrets(sanitizeResultText(text));
}

/**
 * The permission key a tool is offered under, or null when an admin blocked it. `readOnlyHint === true`
 * starts at `mcpRead`, everything else at `mcpWrite`. `tool_permissions` only tightens: `blocked` drops
 * the tool; `require_approval` moves a tool that the workspace lets run without a card to `mcpWrite`
 * (which can never be always-allow); `always_allow` there changes nothing.
 */
function permissionFor(
  annotations: DataObject | undefined,
  toolPermission: AssistantPermissionMode | undefined,
  settings: EffectiveAssistantSettings,
): AssistantPermissionKey | null {
  let key: AssistantPermissionKey = annotations?.readOnlyHint === true ? 'mcpRead' : 'mcpWrite';
  if (toolPermission === 'blocked') return null;
  if (toolPermission === 'require_approval' && settings.permissions[key] === 'always_allow') key = 'mcpWrite';
  return key;
}

/** the per-tool mode saved for `toolName` (the saved key may be the server's own name) */
function savedToolPermission(
  row: AssistantMcpConnectionRow,
  toolName: string,
): AssistantPermissionMode | undefined {
  const saved = row.toolPermissions ?? {};
  let found: AssistantPermissionMode | undefined = saved[toolName];
  for (const [key, mode] of Object.entries(saved)) {
    if (nameToken(key) === toolName) {
      // blocked wins over a looser mode saved under two spellings of one name
      if (mode === 'blocked' || found === undefined) found = mode;
    }
  }
  return found;
}

function approvalCopy(row: AssistantMcpConnectionRow, toolName: string, input: DataObject): ApprovalCopy {
  let host = '';
  try {
    host = new URL(row.url).host;
  } catch {
    host = '';
  }
  const args = Object.entries(input ?? {})
    .slice(0, 20)
    .map(([label, value]) => ({
      label: cut(stripInvisible(label), 100),
      value: cut(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''), 500),
    }));
  return {
    title: `Run ${toolName} on ${row.name}`,
    resourceName: row.name,
    details: {
      facts: [
        { label: 'MCP server', value: row.name },
        { label: 'Address', value: host },
        { label: 'Tool', value: toolName },
        ...args,
      ],
    },
  };
}

/** the definition for the one-parent run: the Agent node and the MCP Client Tool wired to it */
async function connectionDefinition(
  ctx: ServerContext,
  tenantId: string,
  row: AssistantMcpConnectionRow,
): Promise<WorkflowDefinition> {
  const agentType = ctx.registries.nodeTypes.get(AGENT_TYPE);
  const mcpType = ctx.registries.nodeTypes.get(MCP_TOOL_TYPE);
  if (!agentType || !mcpType) throw new Error('The AI nodes are not installed');
  const url = validateMcpUrl(row.url);
  if (!url.ok) throw new Error(url.reason);
  const credentialType = MCP_CREDENTIAL_TYPES[row.authentication];
  let credentials: Record<string, { id: string; name: string }> | undefined;
  if (credentialType) {
    // the foreign key does not prove the tenant: the credential is read by tenant and type here
    const credential = row.credentialId
      ? await ctx.repos.credentials.get(tenantId, row.credentialId)
      : undefined;
    if (!credential || credential.type !== credentialType) {
      throw new Error('The credential of this connection is missing or is not the right type');
    }
    credentials = { [credentialType]: { id: credential.id, name: credential.name } };
  }
  return {
    name: 'Assistant MCP',
    nodes: [
      {
        id: randomUUID(),
        name: PARENT_NAME,
        type: AGENT_TYPE,
        typeVersion: latestVersion(agentType.description),
        position: [0, 0],
        parameters: {},
      },
      {
        id: randomUUID(),
        name: SERVER_NAME,
        type: MCP_TOOL_TYPE,
        typeVersion: latestVersion(mcpType.description),
        position: [0, 200],
        parameters: {
          endpointUrl: url.url.toString(),
          serverTransport: row.transport,
          authentication: row.authentication,
          include: 'all',
          options: { timeout: MCP_TIMEOUT_MS },
        },
        ...(credentials ? { credentials } : {}),
      },
    ],
    connections: {
      [SERVER_NAME]: { ai_tool: [[{ node: PARENT_NAME, type: 'ai_tool', index: 0 }]] },
    },
  };
}

/**
 * Opens one connection and turns its tools into definitions. Throws when the server cannot be opened
 * (the caller turns that into a note). `dropBlocked` leaves out a tool an admin turned off: the turn's
 * tool list does, a reopened approved call keeps it so the approval step says why it was refused.
 */
async function openConnection(
  ctx: ServerContext,
  tenant: AssistantRunScope['tenant'],
  signal: AbortSignal,
  row: AssistantMcpConnectionRow,
  access: Access,
  taken: Set<string>,
  dropBlocked: boolean,
): Promise<OpenedServer> {
  const definition = await connectionDefinition(ctx, tenant.id, row);
  const sub = await openSubNodes(ctx, tenant, definition, PARENT_NAME, signal);
  const notes: string[] = [];
  const defs: AssistantToolDefinition[] = [];
  try {
    const supplied = await sub.get('ai_tool');
    // one entry per connected sub-node, each the list of tools it supplies
    const aiTools = [supplied]
      .flat(Infinity)
      .filter((tool): tool is AiTool => (tool as AiTool | undefined)?.kind === 'tool');
    for (const aiTool of aiTools) {
      const toolName = String(aiTool.name ?? '');
      const name = mcpToolName(row.name, toolName);
      if (!name) {
        notes.push(`${row.name}: a tool name is not valid, so it was left out`);
        continue;
      }
      if (taken.has(name)) {
        notes.push(`${row.name}: "${name}" is already used by another tool, so it was left out`);
        continue;
      }
      const schema = sanitizeSchema(aiTool.parameters);
      if (!schema.ok) {
        notes.push(`${row.name}: "${toolName}" was left out because ${schema.reason}`);
        continue;
      }
      const permission = permissionFor(
        aiTool.annotations,
        savedToolPermission(row, toolName),
        access.settings,
      );
      if (permission === null) continue;
      if (dropBlocked && access.settings.permissions[permission] === 'blocked') continue;
      taken.add(name);
      defs.push(toDefinition(row, aiTool, name, toolName, permission, schema.schema));
    }
  } catch (error) {
    await sub.close().catch(() => undefined);
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sub.close().catch(() => undefined);
  };
  if (defs.length === 0) await close();
  return { defs, notes, close };
}

function toDefinition(
  row: AssistantMcpConnectionRow,
  aiTool: AiTool,
  name: string,
  toolName: string,
  permission: AssistantPermissionKey,
  schema: unknown,
): AssistantToolDefinition<DataObject> {
  const input = z.record(z.string(), z.unknown());
  // the model reads the sanitized schema (`toolParameters` calls `z.toJSONSchema`, which asks the schema)
  (input._zod as unknown as { toJSONSchema?: () => unknown }).toJSONSchema = () => schema;
  const description = sanitizeToolDescription(aiTool.description) || toolName;
  return {
    name,
    description: cut(`[MCP server "${nameToken(row.name)}"] ${description}`, MCP_LIMITS.toolDescriptionChars),
    input: input as unknown as z.ZodType<DataObject>,
    // a server that lies with `readOnlyHint` cannot hand a viewer a write: editor, always
    minRole: 'editor',
    permission,
    untrusted: `mcp:${row.name}`,
    grantKey: () => name,
    approval: async (_ctx, _caller, args) => approvalCopy(row, toolName, args),
    async handler(_ctx, run, args) {
      const options = { signal: run.signal };
      if (aiTool.invokeRaw) {
        const result = await aiTool.invokeRaw(args ?? {}, options);
        const text = resultText(result.content, result.structuredContent);
        if (result.isError) throw new Error(text || `The tool "${toolName}" failed`);
        return text;
      }
      return resultText(
        [{ type: 'text', text: String(await aiTool.invoke(args ?? {}, options)) }],
        undefined,
      );
    },
  };
}

/** access for a turn: MCP access on and the caller at least an editor */
function mayUse(settings: EffectiveAssistantSettings, role: AssistantRunScope['role']): boolean {
  return settings.mcpAccessEnabled && hasRole(role, 'editor');
}

/** the MCP tools of this turn and the `close()` the turn runs in its `finally` */
export async function openMcpTools(
  ctx: ServerContext,
  run: AssistantRunScope,
): Promise<{ tools: AssistantToolDefinition[]; close(): Promise<void> }> {
  const none = { tools: [] as AssistantToolDefinition[], close: async () => {} };
  if (!mayUse(run.settings, run.role)) return none;
  const rows = (await ctx.repos.assistantMcp.list(run.tenant.id)).filter((row) => row.enabled);
  if (rows.length === 0) return none;

  const taken = new Set(builtInAssistantTools().map((tool) => tool.name));
  const access: Access = { settings: run.settings };
  // servers open at the same time; their tools are named in connection order afterwards
  const results = await Promise.all(
    rows.map(async (row) => {
      try {
        // names are claimed in order below, so each server starts from its own copy
        return {
          row,
          opened: await openConnection(ctx, run.tenant, run.signal, row, access, new Set(), true),
        };
      } catch (error) {
        return { row, error };
      }
    }),
  );

  const tools: AssistantToolDefinition[] = [];
  const closers: Array<() => Promise<void>> = [];
  for (const result of results) {
    if ('error' in result) {
      run.emit({
        type: 'status',
        runId: run.runId,
        payload: {
          message: `MCP server "${noteText(result.row.name)}" is not available: ${noteText(result.error)}`,
        },
      });
      continue;
    }
    closers.push(result.opened.close);
    for (const note of result.opened.notes) {
      run.emit({ type: 'status', runId: run.runId, payload: { message: noteText(note) } });
    }
    for (const def of result.opened.defs) {
      if (taken.has(def.name)) {
        run.emit({
          type: 'status',
          runId: run.runId,
          payload: { message: noteText(`"${def.name}" is already used by another tool, so it was left out`) },
        });
        continue;
      }
      taken.add(def.name);
      tools.push(def);
    }
  }
  return {
    tools,
    close: async () => {
      await Promise.allSettled(closers.map((close) => close()));
    },
  };
}

/**
 * Reopens the connection of the MCP tool `name` for an approved call after a stop, under the same role
 * and access rules read again now; undefined when it is not an MCP tool, access is off or the role is
 * too low, or the connection or the tool no longer exists. The caller closes the connection.
 */
export async function resolveMcpTool(
  ctx: ServerContext,
  run: AssistantRunScope,
  name: string,
): Promise<{ tool: AssistantToolDefinition; close(): Promise<void> } | undefined> {
  if (typeof name !== 'string' || !name.startsWith('mcp_')) return undefined;
  const tenant = (await ctx.repos.tenants.get(run.tenant.id)) ?? run.tenant;
  const membership = await ctx.repos.memberships.get(tenant.id, run.user.id);
  if (!membership) return undefined;
  const settings = await ctx.assistantSettings.read(tenant);
  if (!mayUse(settings, membership.role)) return undefined;

  const rows = (await ctx.repos.assistantMcp.list(tenant.id)).filter((row) => row.enabled);
  // the connection whose prefix matches; with two matches the longer connection name is the better fit
  const candidates = rows
    .map((row) => ({ row, prefix: mcpToolPrefix(row.name) }))
    .filter(
      (entry): entry is { row: AssistantMcpConnectionRow; prefix: string } =>
        entry.prefix !== null && name.startsWith(entry.prefix),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { row } of candidates) {
    let opened: OpenedServer;
    try {
      opened = await openConnection(ctx, tenant, run.signal, row, { settings }, new Set(), false);
    } catch {
      continue;
    }
    const tool = opened.defs.find((def) => def.name === name);
    if (tool) return { tool, close: opened.close };
    await opened.close();
  }
  return undefined;
}
