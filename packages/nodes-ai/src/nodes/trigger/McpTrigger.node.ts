/**
 * MCP Server Trigger: serves the tools connected to its Tools input as an MCP server endpoint
 * (Streamable HTTP, legacy SSE, and the stateless 2026-07-28 revision) under `/mcp/<path>` and
 * `/mcp-test/<path>`. The server's services/mcp-trigger.ts owns transports, sessions and runs; this node owns
 * auth and the answers that need no run:
 *
 * - `webhook` checks auth first (None, Bearer, Header Auth with a constant-time compare, Workspace sign-in),
 *   401 with `WWW-Authenticate` when refused; an unknown method is refused too (fail closed). Then `initialize`
 *   and `server/discover` answer with the server's identity (name from the node name, version 0.1.0,
 *   instructions), and every other message returns the base item `{ body, headers, user? }` with the auth
 *   headers redacted. For `tools/list` the server calls again under `MCP_TOOLS_LIST_HOOK` with sub-nodes that
 *   see that base item (n8n's tool input), and the node answers with the connected tools.
 *   `customData.mcpSubject` hands the server the hash of who authenticated, which binds a session; the server
 *   never starts a run with it.
 * - `execute` runs one `tools/call` inside the execution the server started: it supplies the tools by the
 *   normal sub-node path, calls the named one with the arguments as data (never expressions) and returns the
 *   item with `mcpToolResult` (or `mcpError` for an unknown tool).
 */
import { createHash } from 'node:crypto';
import {
  type DataObject,
  type FormUser,
  type Item,
  isModernMcpRequest,
  isPlainObject,
  isToolSuspension,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MCP_ERRORS,
  MCP_LATEST_REVISION,
  MCP_LEGACY_REVISIONS,
  MCP_TOOLS_LIST_HOOK,
  type McpServerInfo,
  mcpCompleteResult,
  mcpDiscoverResult,
  mcpInitializeResult,
  mcpResult,
  mcpResultFromValue,
  type NodeType,
  negotiateMcpVersion,
  parseMcpMessage,
  type WebhookContext,
  type WebhookResponseData,
} from '@workflow/workflow';
import { getTools } from '../../shared/ai-inputs';
import { callMcpTool, mcpToolDescriptors, redactMcpHeaders } from '../../shared/mcp-server';
import { toToolName } from '../../shared/utils';
import { CHAT_AUTH_TEXTS, headerValue, safeEqual } from './chat-access';
import { checkWorkspaceSignIn, MCP_SIGNIN_TEXTS } from './mcp-trigger-signin';

/** the version every MCP Server Trigger reports (n8n's) */
export const MCP_TRIGGER_VERSION = '0.1.0';

/** the item field the server reads the session subject from (`WebhookResponseData.customData`) */
export const MCP_SUBJECT_KEY = 'mcpSubject';

const REALM = 'MCP Server';

/** the methods `authenticate` knows; any other value is refused, never served open */
const AUTH_MODES = ['none', 'bearerAuth', 'headerAuth', 'n8nOAuth2'];

const UNKNOWN_AUTH = "Couldn't check the MCP client: the authentication method is unknown";

interface McpAuthResult {
  /** set when the caller is refused: send it instead of answering */
  refusal?: WebhookResponseData;
  /** SHA-256 of who authenticated, '' with no auth */
  subject: string;
  /** header names to hide besides `authorization` and `cookie` (the Header Auth credential's) */
  redact: string[];
  /** the signed-in user (Workspace sign-in) */
  user?: FormUser;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const refuse = (statusCode: number, description: string, scheme?: string): McpAuthResult => ({
  subject: '',
  redact: [],
  refusal: {
    webhookResponse: {
      statusCode,
      headers: {
        'content-type': 'application/json',
        ...(scheme ? { 'www-authenticate': `${scheme} realm="${REALM}"` } : {}),
      },
      body: { error: statusCode === 401 ? 'unauthorized' : 'server_error', error_description: description },
    },
  },
});

async function credentialOf(ctx: WebhookContext, type: string): Promise<DataObject | undefined> {
  try {
    return await ctx.getCredentials(type);
  } catch {
    return undefined;
  }
}

/** the trigger's request path (the OAuth resource); the host builds the resource on the MCP base URL */
function resourceUrl(ctx: WebhookContext): string {
  return (ctx.getRequestObject().url ?? '').split('?')[0];
}

async function authenticate(ctx: WebhookContext): Promise<McpAuthResult> {
  const mode = String(ctx.getNodeParameter('authentication', 0, 'none'));
  // fail closed: only None serves without a check
  if (!AUTH_MODES.includes(mode)) return refuse(500, UNKNOWN_AUTH);
  if (mode === 'bearerAuth') {
    const token = String((await credentialOf(ctx, 'httpBearerAuth'))?.token ?? '');
    if (!token) return refuse(500, CHAT_AUTH_TEXTS.missing);
    const header = headerValue(ctx, 'authorization');
    if (!header) return refuse(401, CHAT_AUTH_TEXTS.required, 'Bearer');
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !safeEqual(match[1], token)) return refuse(401, CHAT_AUTH_TEXTS.wrong, 'Bearer');
    return { subject: sha256(`bearer:${token}`), redact: [] };
  }
  if (mode === 'headerAuth') {
    const credential = await credentialOf(ctx, 'httpHeaderAuth');
    const name = String(credential?.name ?? '')
      .trim()
      .toLowerCase();
    const expected = String(credential?.value ?? '');
    if (!name || !expected) return refuse(500, CHAT_AUTH_TEXTS.missing);
    const sent = headerValue(ctx, name);
    if (sent === undefined) return refuse(401, CHAT_AUTH_TEXTS.required, 'Header');
    if (!safeEqual(sent, expected)) return refuse(401, CHAT_AUTH_TEXTS.wrong, 'Header');
    return { subject: sha256(`header:${name}:${expected}`), redact: [name] };
  }
  if (mode === 'n8nOAuth2') {
    // a host without the sign-in helper refuses the caller (401), never an error page
    if (!ctx.getMcpAuth?.()) return refuse(401, MCP_SIGNIN_TEXTS.unavailable, 'Bearer');
    const requireExecuteAccess = ctx.getNodeParameter('requireExecuteAccess', 0, true) !== false;
    const signIn = await checkWorkspaceSignIn(ctx, resourceUrl(ctx), requireExecuteAccess);
    if (!signIn.allowed) return { subject: '', redact: [], refusal: { webhookResponse: signIn.response } };
    return { subject: sha256(`user:${signIn.user.id}`), redact: [], user: signIn.user };
  }
  return { subject: '', redact: [] };
}

function serverInfo(ctx: WebhookContext): McpServerInfo {
  const instructions = ctx.getNodeParameter('instructions', 0, '');
  return {
    name: toToolName(ctx.getNode().name),
    version: MCP_TRIGGER_VERSION,
    instructions: instructions === undefined || instructions === null ? '' : String(instructions),
  };
}

/**
 * the answer of a request this node serves without a run; undefined for the server's own and the run's. `tools/list`
 * is answered only under `MCP_TOOLS_LIST_HOOK`, where the server gives the sub-nodes the request's base item.
 */
async function answer(
  ctx: WebhookContext,
  message: JsonRpcRequest,
  withTools: boolean,
): Promise<JsonRpcResponse | undefined> {
  switch (message.method) {
    case 'initialize': {
      // the 2026 revision has no initialize: a client asking for it gets the newest 2025 revision
      const negotiated = negotiateMcpVersion(message.params?.protocolVersion);
      const protocolVersion = negotiated === MCP_LATEST_REVISION ? MCP_LEGACY_REVISIONS[0] : negotiated;
      return mcpResult(message.id, mcpInitializeResult({ ...serverInfo(ctx), protocolVersion }));
    }
    case 'server/discover':
      return mcpResult(message.id, mcpDiscoverResult(serverInfo(ctx)));
    case 'tools/list': {
      if (!withTools) return undefined;
      const result: DataObject = { tools: mcpToolDescriptors(await getTools(ctx, 0)) as unknown as DataObject[] };
      return mcpResult(message.id, isModernMcpRequest(message) ? mcpCompleteResult(message.method, result) : result);
    }
    default:
      return undefined;
  }
}

/** the four user fields n8n puts in the item */
const userFields = (user: FormUser): DataObject => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
});

const WAIT_ANSWERED = 'The tool finished its wait after the MCP client stopped waiting';

/** the webhook path of every hook: the node's `path` parameter, served verbatim */
const MCP_PATH = '={{$parameter["path"]}}';

export const McpTriggerNode: NodeType = {
  description: {
    name: 'ai.mcpTrigger',
    displayName: 'MCP Server Trigger',
    description: 'Expose workflow tools as an MCP Server endpoint',
    icon: 'lucide:server',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'MCP Server Trigger' },
    inputs: [{ type: 'ai_tool', displayName: 'Tools' }],
    outputs: [],
    categories: ['AI', 'Triggers'],
    alias: ['mcp', 'model context protocol', 'mcp server', 'tools server'],
    activationMessage:
      'You can now connect your MCP Clients to the URL, using SSE or Streamable HTTP transports.',
    credentials: [
      {
        name: 'httpBearerAuth',
        required: true,
        displayOptions: { show: { authentication: ['bearerAuth'] } },
      },
      {
        name: 'httpHeaderAuth',
        required: true,
        displayOptions: { show: { authentication: ['headerAuth'] } },
      },
    ],
    // `hookOf` finds a hook by name, so the three methods carry three names
    webhooks: [
      {
        name: 'setup',
        httpMethod: 'GET',
        path: MCP_PATH,
        responseMode: 'onReceived',
        isFullPath: true,
        nodeType: 'mcp',
      },
      {
        name: 'default',
        httpMethod: 'POST',
        path: MCP_PATH,
        responseMode: 'onReceived',
        isFullPath: true,
        nodeType: 'mcp',
      },
      {
        name: 'sessionEnd',
        httpMethod: 'DELETE',
        path: MCP_PATH,
        responseMode: 'onReceived',
        isFullPath: true,
        nodeType: 'mcp',
      },
    ],
    properties: [
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        description: 'How MCP clients prove who they are',
        options: [
          { name: 'None', value: 'none' },
          {
            name: 'Workspace sign-in',
            value: 'n8nOAuth2',
            description: 'MCP clients sign in with a workspace account (OAuth)',
          },
          { name: 'Bearer Auth', value: 'bearerAuth' },
          { name: 'Header Auth', value: 'headerAuth' },
        ],
      },
      {
        displayName: 'Require Workflow Execute Permission',
        name: 'requireExecuteAccess',
        type: 'boolean',
        default: true,
        description: 'Whether the signed-in user must be allowed to run this workflow',
        displayOptions: { show: { authentication: ['n8nOAuth2'] } },
      },
      {
        displayName: 'Include User in Output',
        name: 'includeUserInOutput',
        type: 'boolean',
        default: true,
        description: 'Whether the output item carries the signed-in user (id, email, first and last name)',
        displayOptions: { show: { authentication: ['n8nOAuth2'] } },
      },
      {
        displayName: 'Path',
        name: 'path',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'my-tools',
        description: 'The path of this MCP server, after /mcp/',
      },
      {
        displayName: 'Instructions',
        name: 'instructions',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        description: 'Sent to MCP clients when they connect: how and when to use these tools',
      },
    ],
  },

  async webhook(ctx) {
    const auth = await authenticate(ctx);
    if (auth.refusal) return auth.refusal;
    const customData = { [MCP_SUBJECT_KEY]: auth.subject };
    const request = ctx.getRequestObject();
    const hook = ctx.getWebhookName();
    if (hook === 'default' || hook === MCP_TOOLS_LIST_HOOK) {
      const parsed = parseMcpMessage(request.body);
      const reply =
        parsed.kind === 'request'
          ? await answer(ctx, parsed.message, hook === MCP_TOOLS_LIST_HOOK)
          : undefined;
      if (reply) {
        return {
          webhookResponse: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: reply },
          customData,
        };
      }
    }
    // the base item of every other message: what the tools see as `$json`, at a call and (through the server's
    // second call under MCP_TOOLS_LIST_HOOK) at tools/list
    const item: DataObject = {
      body: (request.body ?? {}) as DataObject[keyof DataObject],
      headers: redactMcpHeaders(request.headers, auth.redact),
    };
    if (auth.user && ctx.getNodeParameter('includeUserInOutput', 0, true) !== false) {
      item.user = userFields(auth.user);
    }
    return { workflowData: [[{ json: item }]], customData };
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const resumed = ctx.getResumeData();
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      const json = items[i].json;
      const call = json.mcpToolCall;
      if (!isPlainObject(call) || typeof call.toolName !== 'string') {
        out.push({ json });
        continue;
      }
      if (resumed) {
        // the client got its "waiting" answer long ago; the run records what the person answered
        const answered = resumed.answer?.[0]?.[0]?.json;
        out.push({ json: { ...json, mcpToolResult: mcpResultFromValue(answered ?? WAIT_ANSWERED) as never } });
        continue;
      }
      const tool = (await getTools(ctx, i)).find((t) => t.name === call.toolName);
      if (!tool) {
        out.push({ json: { ...json, mcpError: { code: MCP_ERRORS.INVALID_PARAMS, message: 'Tool not found' } } });
        continue;
      }
      // the arguments are the client's data: handed to the tool as they came, never evaluated
      const args = isPlainObject(call.arguments) ? call.arguments : {};
      try {
        const result = await callMcpTool(tool, args, ctx.signal);
        out.push({ json: { ...json, mcpToolResult: result as never } });
      } catch (error) {
        if (!isToolSuspension(error)) throw error;
        // the run waits for a person; the server answers the client that the tool cannot answer here
        ctx.suspendForTool(error, { itemIndex: i });
        return [out];
      }
    }
    return [out];
  },
};
