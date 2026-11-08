/**
 * Properties and credentials the MCP Client Tool and the MCP Client node share: the endpoint, the server
 * transport and the authentication list. Both nodes read them through `createMcpConnection`.
 */
import type { NodeCredentialDescription, NodeProperty } from '@workflow/workflow';

export const MCP_CLIENT_PROPERTIES: NodeProperty[] = [
  {
    displayName: 'Server Transport',
    name: 'serverTransport',
    type: 'options',
    default: 'httpStreamable',
    options: [
      { name: 'HTTP Streamable', value: 'httpStreamable' },
      { name: 'Server Sent Events (Deprecated)', value: 'sse' },
    ],
    description: 'How the MCP server is reached. Server Sent Events is deprecated by the MCP specification.',
  },
  {
    displayName: 'Endpoint',
    name: 'endpointUrl',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://mcp.example.com/mcp',
    description: 'URL of the MCP server',
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
      { name: 'Multiple Headers Auth', value: 'multipleHeadersAuth' },
      { name: 'MCP OAuth2', value: 'mcpOAuth2Api' },
    ],
  },
];

export const MCP_CLIENT_CREDENTIALS: NodeCredentialDescription[] = [
  { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
  {
    name: 'httpMultipleHeadersAuth',
    required: true,
    displayOptions: { show: { authentication: ['multipleHeadersAuth'] } },
  },
  { name: 'mcpOAuth2Api', required: true, displayOptions: { show: { authentication: ['mcpOAuth2Api'] } } },
];
