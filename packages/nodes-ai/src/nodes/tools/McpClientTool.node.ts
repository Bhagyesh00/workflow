/**
 * MCP Client Tool: connects to an MCP server (Streamable HTTP) and offers its tools to the agent.
 * Requests go through `ctx.helpers.httpRequest`, so the server URL is subject to the SSRF policy.
 */
import {
  type BaseContext,
  type DataObject,
  type HttpFullResponse,
  type JsonSchema,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { McpClient, type McpTool, mcpResultText } from '../../shared/mcp-client';
import { acquireShared, type Shared, sharedKey } from '../../shared/shared-resource';
import { createTool } from '../../shared/tools';
import { errorMessage, toToolName } from '../../shared/utils';

async function authHeaders(
  ctx: Pick<BaseContext, 'getCredentials'>,
  authentication: string,
  itemIndex = 0,
): Promise<Record<string, string>> {
  if (authentication === 'bearerAuth') {
    const creds = await ctx.getCredentials('httpBearerAuth', itemIndex);
    return { authorization: `Bearer ${String(creds.token ?? '')}` };
  }
  if (authentication === 'headerAuth') {
    const creds = await ctx.getCredentials('httpHeaderAuth', itemIndex);
    if (!creds.name) throw new Error('The header auth credential has no header name');
    return { [String(creds.name).toLowerCase()]: String(creds.value ?? '') };
  }
  return {};
}

function createClient(
  ctx: Pick<BaseContext, 'helpers'>,
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
): McpClient {
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('The MCP endpoint must be an http(s) URL');
  return new McpClient(
    async (request) => (await ctx.helpers.httpRequest<string>(request)) as HttpFullResponse<string>,
    endpoint,
    headers,
    timeoutMs,
  );
}

export function selectTools<T extends { name: string }>(
  tools: T[],
  include: string,
  selected: string[],
): T[] {
  if (include === 'selected') return tools.filter((t) => selected.includes(t.name));
  if (include === 'except') return tools.filter((t) => !selected.includes(t.name));
  return tools;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

export const McpClientToolNode: NodeType = {
  description: {
    name: 'ai.mcpClientTool',
    displayName: 'MCP Client Tool',
    description: 'Gives the agent the tools of a Model Context Protocol server',
    icon: 'lucide:plug',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MCP Client' },
    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tools'],
    categories: ['AI', 'Tools'],
    alias: ['mcp', 'model context protocol', 'tools server'],
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
    properties: [
      {
        displayName: 'Endpoint',
        name: 'endpointUrl',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://mcp.example.com/mcp',
        description: 'Streamable HTTP endpoint of the MCP server',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Bearer Auth', value: 'bearerAuth' },
          { name: 'Header Auth', value: 'headerAuth' },
        ],
      },
      {
        displayName: 'Tools to Include',
        name: 'include',
        type: 'options',
        default: 'all',
        options: [
          { name: 'All', value: 'all' },
          { name: 'Selected', value: 'selected' },
          { name: 'All Except', value: 'except' },
        ],
      },
      {
        displayName: 'Tools',
        name: 'includeTools',
        type: 'multiOptions',
        default: [],
        typeOptions: {
          loadOptionsMethod: 'listTools',
          loadOptionsDependsOn: ['endpointUrl', 'authentication'],
        },
        displayOptions: { show: { include: ['selected'] } },
      },
      {
        displayName: 'Tools to Exclude',
        name: 'excludeTools',
        type: 'multiOptions',
        default: [],
        typeOptions: {
          loadOptionsMethod: 'listTools',
          loadOptionsDependsOn: ['endpointUrl', 'authentication'],
        },
        displayOptions: { show: { include: ['except'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [{ displayName: 'Timeout (ms)', name: 'timeout', type: 'number', default: 60_000 }],
      },
    ],
  },

  async supplyData(ctx, itemIndex) {
    const endpoint = String(ctx.getNodeParameter('endpointUrl', itemIndex, '') ?? '').trim();
    const authentication = String(ctx.getNodeParameter('authentication', itemIndex, 'none'));
    const include = String(ctx.getNodeParameter('include', itemIndex, 'all'));
    const selected = asList(
      include === 'selected'
        ? ctx.getNodeParameter('includeTools', itemIndex, [])
        : include === 'except'
          ? ctx.getNodeParameter('excludeTools', itemIndex, [])
          : [],
    );
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    let shared: Shared<{ client: McpClient; tools: McpTool[] }>;
    try {
      const headers = await authHeaders(ctx, authentication, itemIndex);
      const timeout = Number(options.timeout ?? 60_000);
      // one session per node and execution, shared by every item the agent processes
      shared = await acquireShared(
        sharedKey(ctx, 'mcp', endpoint, headers, timeout),
        async () => {
          const client = createClient(ctx, endpoint, headers, timeout);
          await client.connect();
          return { client, tools: await client.listTools() };
        },
        ({ client }) => client.close(),
      );
    } catch (error) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Could not connect to the MCP server: ${errorMessage(error)}`,
        {
          itemIndex,
          cause: error,
        },
      );
    }
    const { client } = shared.value;
    const serverTools = selectTools(shared.value.tools, include, selected);
    const tools = serverTools.map((tool) => {
      const parameters: JsonSchema = { type: 'object', properties: {}, ...(tool.inputSchema ?? {}) };
      return createTool(
        ctx,
        { name: toToolName(tool.name), description: tool.description ?? tool.name, parameters },
        async (args) => {
          const result = await client.callTool(tool.name, args);
          const text = mcpResultText(result);
          if (result.isError) throw new Error(text || `The MCP tool "${tool.name}" reported an error`);
          return text;
        },
      );
    });
    return { response: tools, closeFunction: shared.release };
  },

  methods: {
    loadOptions: {
      async listTools(ctx: LoadOptionsContext) {
        const endpoint = String(ctx.getCurrentNodeParameter('endpointUrl') ?? '').trim();
        if (!endpoint) return [];
        const authentication = String(ctx.getCurrentNodeParameter('authentication') ?? 'none');
        const client = createClient(ctx, endpoint, await authHeaders(ctx, authentication), 30_000);
        try {
          await client.connect();
          const tools = await client.listTools();
          return tools.map((t) => ({ name: t.name, value: t.name, description: t.description }));
        } finally {
          await client.close();
        }
      },
    },
  },
};
