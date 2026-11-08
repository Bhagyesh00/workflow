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
  ASSISTANT_RESULT_CHARS,
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
/** arguments one call may send: each is shown on the approval card */
export const MCP_MAX_ARGUMENTS = 50;

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
  // every member can read the address, so a key in it would be shown to all of them
  if (url.search || url.hash) {
    return {
      ok: false,
      reason: 'The address must not hold a query string or a fragment. Put a key in a header credential',
    };
  }
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

/**
 * The per-tool mode saved for `toolName`: the saved key may be the server's own name or the name the chat
 * shows (`mcp_<connection>_<tool>`).
 */
function savedToolPermission(
  row: AssistantMcpConnectionRow,
  toolName: string,
): AssistantPermissionMode | undefined {
  const saved = row.toolPermissions ?? {};
  const shown = mcpToolName(row.name, toolName);
  let found: AssistantPermissionMode | undefined = saved[toolName];
  for (const [key, mode] of Object.entries(saved)) {
    const token = nameToken(key);
    if (token === toolName || (shown !== null && token === shown)) {
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
  // every argument the server will get is on the card (the input allows at most MCP_MAX_ARGUMENTS)
  const entries = Object.entries(input ?? {});
  const args = entries.slice(0, MCP_MAX_ARGUMENTS).map(([label, value]) => ({
    label: cut(stripInvisible(label), 100),
    value: cut(stripInvisible(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')), 500),
  }));
  const hidden = entries.length - args.length;
  return {
    title: `Run ${toolName} on ${row.name}`,
    resourceName: row.name,
    details: {
      facts: [
        { label: 'MCP server', value: row.name },
        { label: 'Address', value: host },
        { label: 'Tool', value: toolName },
        ...args,
        ...(hidden > 0 ? [{ label: 'More arguments not shown', value: String(hidden) }] : []),
      ],
    },
  };
}

/**
 * The card's grant key of a server's tool: the connection id and the server's own tool name. A reopened
 * approved call runs only on that connection and that tool (`resolveMcpTool`), and an "always allow" for
 * one connection never covers another connection's tool of the same chat name.
 */
export function mcpGrantKey(connectionId: string, toolName: string): string {
  return `mcp:${connectionId}:${toolName}`;
}

/** the connection id held by an `mcpGrantKey`, or null for any other key */
function grantConnectionId(grantKey: string | null | undefined): string | null {
  if (typeof grantKey !== 'string' || !grantKey.startsWith('mcp:')) return null;
  const end = grantKey.indexOf(':', 4);
  return end > 4 ? grantKey.slice(4, end) : null;
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
  const shaped = z.record(z.string(), z.unknown());
  // the model reads the sanitized schema (`toolParameters` calls `z.toJSONSchema`, which asks the schema;
  // a pipe's input side is `shaped`, since a refined schema cannot carry this override)
  (shaped._zod as unknown as { toJSONSchema?: () => unknown }).toJSONSchema = () => schema;
  const input = shaped.pipe(
    z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length <= MCP_MAX_ARGUMENTS, {
      message: `Send at most ${MCP_MAX_ARGUMENTS} arguments`,
    }),
  );
  const description = sanitizeToolDescription(aiTool.description) || toolName;
  return {
    name,
    description: cut(`[MCP server "${nameToken(row.name)}"] ${description}`, MCP_LIMITS.toolDescriptionChars),
    input: input as unknown as z.ZodType<DataObject>,
    // a server that lies with `readOnlyHint` cannot hand a viewer a write: editor, always
    minRole: 'editor',
    permission,
    untrusted: `mcp:${row.name}`,
    grantKey: () => mcpGrantKey(row.id, toolName),
    approval: async (_ctx, _caller, args) => approvalCopy(row, toolName, args),
    async handler(_ctx, run, args) {
      const options = { signal: run.signal };
      let failure: string;
      try {
        if (!aiTool.invokeRaw) {
          return resultText(
            [{ type: 'text', text: String(await aiTool.invoke(args ?? {}, options)) }],
            undefined,
          );
        }
        const result = await aiTool.invokeRaw(args ?? {}, options);
        const text = resultText(result.content, result.structuredContent);
        if (!result.isError) return text;
        failure = text;
      } catch (error) {
        if (run.signal.aborted) throw error;
        // a JSON-RPC or transport error carries the server's own text
        const message = error instanceof Error ? error.message : String(error);
        failure = resultText([{ type: 'text', text: message }], undefined);
      }
      // the server's error text is cleaned and capped like a result; the caller wraps it as untrusted
      // (`shapeToolError`) with this definition's `untrusted` source
      throw new Error(cut(failure || `The tool "${toolName}" failed`, ASSISTANT_RESULT_CHARS));
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
 *
 * `grantKey` is the card's stored key (`mcpGrantKey`): then only that connection is opened, and its tool
 * must still have the server name the card showed, so the call runs on the server and tool the person
 * approved. With no such key the connections are tried in list order and the first match wins, the rule
 * `openMcpTools` names tools by.
 */
export async function resolveMcpTool(
  ctx: ServerContext,
  run: AssistantRunScope,
  name: string,
  grantKey?: string | null,
): Promise<{ tool: AssistantToolDefinition; close(): Promise<void> } | undefined> {
  if (typeof name !== 'string' || !name.startsWith('mcp_')) return undefined;
  const tenant = (await ctx.repos.tenants.get(run.tenant.id)) ?? run.tenant;
  const membership = await ctx.repos.memberships.get(tenant.id, run.user.id);
  if (!membership) return undefined;
  const settings = await ctx.assistantSettings.read(tenant);
  if (!mayUse(settings, membership.role)) return undefined;

  const rows = (await ctx.repos.assistantMcp.list(tenant.id)).filter((row) => row.enabled);
  const pinned = grantConnectionId(grantKey);
  // the card's connection only; else every connection whose prefix matches, in list order
  const candidates = pinned
    ? rows.filter((row) => row.id === pinned)
    : rows.filter((row) => {
        const prefix = mcpToolPrefix(row.name);
        return prefix !== null && name.startsWith(prefix);
      });
  for (const row of candidates) {
    let opened: OpenedServer;
    try {
      opened = await openConnection(ctx, tenant, run.signal, row, { settings }, new Set(), false);
    } catch {
      continue;
    }
    const tool = opened.defs.find((def) => def.name === name && (!pinned || def.grantKey?.({}) === grantKey));
    if (tool) return { tool, close: opened.close };
    await opened.close();
  }
  return undefined;
}
