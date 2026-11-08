/**
 * P5-14: the MCP Server Trigger's workspace sign-in hands the helper only the request path, so the
 * resource is built on the configured MCP base URL and never on the Host header or scheme the server saw.
 */
import type { McpAuthHelper, WebhookContext } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { checkWorkspaceSignIn, resourcePath } from '../src/nodes/trigger/mcp-trigger-signin';

function contextWith(helper: McpAuthHelper, authorization?: string): WebhookContext {
  return {
    getMcpAuth: () => helper,
    getHeaderData: () => (authorization ? { authorization } : {}),
    getWorkflow: () => ({ id: 'wf-1' }),
  } as unknown as WebhookContext;
}

function recordingHelper() {
  const seen: string[] = [];
  const helper: McpAuthHelper = {
    async verifyAccessToken(_token, resource) {
      seen.push(resource);
      return { user: { id: 'u1', email: 'a@example.com', firstName: 'A', lastName: '' }, role: 'owner' };
    },
    canExecute: async () => true,
    challenge(resource) {
      seen.push(resource);
      return `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource${resource}"`;
    },
  };
  return { helper, seen };
}

describe('checkWorkspaceSignIn', () => {
  it('gives the helper the request path only, without scheme, Host or query', async () => {
    const { helper, seen } = recordingHelper();
    const result = await checkWorkspaceSignIn(
      contextWith(helper, 'Bearer wfo_at_x'),
      'http://evil.example:8080/mcp/acme/tools?x=1',
      true,
    );
    expect(result.allowed).toBe(true);
    expect(seen).toEqual(['/mcp/acme/tools', '/mcp/acme/tools']);
  });

  it('puts the challenge built from the path on a 401', async () => {
    const { helper, seen } = recordingHelper();
    const result = await checkWorkspaceSignIn(
      contextWith(helper),
      'https://other.example/mcp-test/acme/t',
      false,
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.response.statusCode).toBe(401);
    expect(result.response.headers?.['www-authenticate']).toBe(
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp-test/acme/t"',
    );
    expect(seen).toEqual(['/mcp-test/acme/t']);
  });

  it('reads the path of a URL or a path', () => {
    expect(resourcePath('https://h.example/mcp/a/b?q=1#f')).toBe('/mcp/a/b');
    expect(resourcePath('/mcp/a/b?q=1')).toBe('/mcp/a/b');
  });
});
