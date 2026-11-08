/**
 * Demo Assistant MCP connections (P5-72, lane L9): GET, POST, PATCH and DELETE `/assistant/mcp-connections`
 * (`assistantApi.mcpConnections`, `createMcpConnection`, `patchMcpConnection`, `deleteMcpConnection`) on the
 * in-memory MockBackend. A connection holds a credential id, never a secret. C0 registers nothing.
 */
import type { MockBackend } from './mock-backend';

/** P5-72: registers the demo MCP connection routes (L9). C0: registers nothing. */
export function registerAssistantMcpRoutes(_backend: MockBackend): void {}
