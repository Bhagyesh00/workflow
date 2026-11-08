/**
 * MCP Client Tool: connects to an MCP server (Streamable HTTP or the deprecated SSE) and offers its tools to the agent.
 * Requests go through `ctx.helpers.httpRequest`, so the server URL is subject to the SSRF policy.
 */
import {
  type AiTool,
  type DataObject,
  type JsonSchema,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { type McpClient, type McpTool, type McpToolResult, mcpResultText } from '../../shared/mcp-client';
import { createMcpConnection, mcpConnectFailure, resolveMcpAuth } from '../../shared/mcp-connect';
import { MCP_CLIENT_CREDENTIALS, MCP_CLIENT_PROPERTIES } from '../../shared/mcp-description';
import { acquireShared, type Shared, sharedKey } from '../../shared/shared-resource';
import { createTool } from '../../shared/tools';
import { toToolName } from '../../shared/utils';

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
    credentials: MCP_CLIENT_CREDENTIALS,
    properties: [
      ...MCP_CLIENT_PROPERTIES,
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
          loadOptionsDependsOn: ['endpointUrl', 'serverTransport', 'authentication'],
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
          loadOptionsDependsOn: ['endpointUrl', 'serverTransport', 'authentication'],
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
    const serverTransport = String(ctx.getNodeParameter('serverTransport', itemIndex, 'httpStreamable')) as
      | 'httpStreamable'
      | 'sse';
    let shared: Shared<{ client: McpClient; tools: McpTool[] }>;
    try {
      const auth = await resolveMcpAuth(ctx, authentication, endpoint, itemIndex);
      const timeout = Number(options.timeout ?? 60_000);
      // one session per node and execution, shared by every item the agent processes
      shared = await acquireShared(
        sharedKey(
          ctx,
          'mcp',
          endpoint,
          serverTransport,
          auth.headers,
          auth.credentialType,
          auth.allowedDomains,
          timeout,
        ),
        async () => {
          const client = await createMcpConnection(ctx, {
            endpointUrl: endpoint,
            serverTransport,
            authentication,
            timeoutMs: timeout,
            itemIndex,
          });
          try {
            return { client, tools: await client.listTools() };
          } catch (error) {
            await client.close();
            throw error;
          }
        },
        ({ client }) => client.close(),
      );
    } catch (error) {
      const { message, description } = mcpConnectFailure(error);
      throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description, cause: error });
    }
    const { client } = shared.value;
    const serverTools = selectTools(shared.value.tools, include, selected);
    if (serverTools.length === 0) {
      await shared.release();
      throw new NodeOperationError(ctx.getNode(), 'MCP Server returned no tools', {
        itemIndex,
        description: 'The MCP server is connected, but it offers no tools to use here.',
      });
    }
    const tools = serverTools.map((tool) => {
      const parameters: JsonSchema = { type: 'object', properties: {}, ...(tool.inputSchema ?? {}) };
      const base = createTool(
        ctx,
        { name: toToolName(tool.name), description: tool.description ?? tool.name, parameters },
        async (args) => {
          const result = await client.callTool(tool.name, args);
          const text = mcpResultText(result);
          if (result.isError) throw new Error(text || `Failed to execute tool "${tool.name}"`);
          return text;
        },
      );
      // the server's own content array, for an MCP Server Trigger that passes the result on as it is
      const withRaw: AiTool = {
        ...base,
        // the server's annotations (for example `readOnlyHint`), read by the Assistant's permission check only
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        async invokeRaw(args) {
          const input = { input: args };
          try {
            const result: McpToolResult = await client.callTool(tool.name, args ?? {});
            ctx.logSubNodeRun(input, { response: mcpResultText(result) });
            return {
              content: result.content ?? [],
              ...(result.structuredContent !== undefined
                ? { structuredContent: result.structuredContent }
                : {}),
              ...(result.isError ? { isError: true } : {}),
            };
          } catch (error) {
            ctx.logSubNodeRun(input, {}, error as Error);
            throw error;
          }
        },
      };
      return withRaw;
    });
    return { response: tools, closeFunction: shared.release };
  },

  methods: {
    loadOptions: {
      async listTools(ctx: LoadOptionsContext) {
        const endpoint = String(ctx.getCurrentNodeParameter('endpointUrl') ?? '').trim();
        if (!endpoint) return [];
        const authentication = String(ctx.getCurrentNodeParameter('authentication') ?? 'none');
        const serverTransport = String(ctx.getCurrentNodeParameter('serverTransport') ?? 'httpStreamable') as
          | 'httpStreamable'
          | 'sse';
        const client = await createMcpConnection(ctx, {
          endpointUrl: endpoint,
          serverTransport,
          authentication,
          timeoutMs: 30_000,
        });
        try {
          const tools = await client.listTools();
          return tools.map((t) => ({ name: t.name, value: t.name, description: t.description }));
        } finally {
          await client.close();
        }
      },
    },
  },
};
