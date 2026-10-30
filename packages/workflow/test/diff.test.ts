import { describe, expect, it } from 'vitest';
import {
  classifyError,
  diffWorkflows,
  ExpressionError,
  NodeApiError,
  serializeError,
  type WorkflowDefinition,
} from '../src';

const base: WorkflowDefinition = {
  name: 'wf',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    {
      id: 'b',
      name: 'Set',
      type: 'core.set',
      typeVersion: 1,
      position: [200, 0],
      parameters: { mode: 'raw', jsonOutput: '{}' },
    },
  ],
  connections: { Start: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
  settings: { timezone: 'UTC' },
};

describe('diffWorkflows', () => {
  it('ignores layout-only changes', () => {
    const moved = structuredClone(base);
    moved.nodes[1].position = [999, 999];
    expect(diffWorkflows(base, moved).isEmpty).toBe(true);
  });

  it('reports renames, parameter changes, rewiring and settings', () => {
    const after = structuredClone(base);
    after.nodes[1].name = 'Build payload';
    after.nodes[1].parameters.jsonOutput = '{"a":1}';
    after.nodes.push({
      id: 'c',
      name: 'HTTP',
      type: 'core.httpRequest',
      typeVersion: 1,
      position: [400, 0],
      parameters: {},
    });
    after.connections = {
      Start: { main: [[{ node: 'Build payload', type: 'main', index: 0 }]] },
      'Build payload': { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] },
    };
    after.settings = { timezone: 'Europe/Berlin' };
    const d = diffWorkflows(base, after);
    expect(d.nodes.renamed).toEqual([{ id: 'b', from: 'Set', to: 'Build payload' }]);
    expect(d.nodes.added.map((n) => n.name)).toEqual(['HTTP']);
    expect(d.nodes.changed[0].changes).toEqual([
      { path: 'parameters.jsonOutput', before: '{}', after: '{"a":1}' },
    ]);
    // the Start -> Set connection is unchanged despite the rename
    expect(d.connections.removed).toEqual([]);
    expect(d.connections.added).toEqual([
      { from: 'Build payload', output: 0, to: 'HTTP', input: 0, type: 'main' },
    ]);
    expect(d.settings).toEqual([{ path: 'settings.timezone', before: 'UTC', after: 'Europe/Berlin' }]);
  });
});

describe('error catalogue', () => {
  it('classifies HTTP errors with hints and scrubs secrets from bodies', () => {
    const e = serializeError(
      new NodeApiError('HTTP', 'Unauthorized', {
        httpCode: 401,
        responseBody: { error: 'bad', access_token: 'abc' },
        request: { method: 'GET', url: 'https://api.x.com/me' },
      }),
    );
    expect(e.code).toBe('HTTP_401');
    expect(e.hint).toMatch(/Reconnect/);
    expect(e.response?.body).toContain('[redacted]');
    expect(e.response?.body).not.toContain('abc');
    expect(e.request).toEqual({ method: 'GET', url: 'https://api.x.com/me' });
  });

  it('suggests $json for bare identifiers in expressions', () => {
    const e = serializeError(new ExpressionError('email is not defined'));
    expect(e.code).toBe('EXPRESSION_REFERENCE');
    expect(e.hint).toBe('"email" is not a variable here. Did you mean $json.email?');
  });

  it('classifies SSRF and timeouts', () => {
    expect(classifyError({ name: 'SsrfBlockedError', message: 'x' }).code).toBe('SSRF_BLOCKED');
    expect(
      classifyError({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }).code,
    ).toBe('TIMEOUT');
  });
});
