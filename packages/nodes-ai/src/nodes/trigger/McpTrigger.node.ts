/**
 * MCP Server Trigger: serves the tools connected to its Tools input as an MCP server endpoint
 * (Streamable HTTP) under `/mcp/<path>` and `/mcp-test/<path>`. Each `tools/call` runs as a normal
 * execution that starts at this node. The description is final (C0); `webhook` and `execute` are filled
 * by lane L7, the "Workspace sign-in" mode by L10 (mcp-trigger-signin.ts).
 */
import type { NodeType } from '@workflow/workflow';

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

  async webhook() {
    throw new Error('not implemented (L7)');
  },

  async execute() {
    throw new Error('not implemented (L7)');
  },
};
