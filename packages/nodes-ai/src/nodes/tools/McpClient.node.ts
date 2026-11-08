/**
 * MCP Client: a normal (main in, main out) node that calls one tool of an MCP server per item. Lane L13
 * fills its properties and `execute`, every call through `createMcpConnection`. It has NO `usableAsTool`:
 * its tool variant would be named `ai.mcpClientTool`, the existing MCP Client Tool sub-node.
 */
import type { NodeType } from '@workflow/workflow';

export const McpClientNode: NodeType = {
  description: {
    name: 'ai.mcpClient',
    displayName: 'MCP Client',
    description: 'Call a tool of a Model Context Protocol server',
    icon: 'lucide:plug',
    group: ['transform'],
    version: 1,
    defaults: { name: 'MCP Client' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['AI', 'Tools'],
    alias: ['mcp', 'model context protocol', 'call tool'],
    properties: [],
  },

  async execute() {
    throw new Error('not implemented (L13)');
  },
};
