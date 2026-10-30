import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import { collectExpressions, lintWorkflow, referencedNodes } from '../src/lib/doctor';

const types = new Map(demoNodeTypes.map((d) => [d.name, d]));
const lookup = { get: (t: string) => types.get(t) };

const node = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...extra,
});

const link = (from: string, to: string) => ({
  [from]: { main: [[{ node: to, type: 'main' as const, index: 0 }]] },
});

describe('Workflow Doctor', () => {
  it('finds references to nodes that do not exist or are not upstream', () => {
    const issues = lintWorkflow(
      {
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('A', 'core.set', {
            assignments: {
              assignments: [{ id: '1', name: 'x', type: 'string', value: "={{ $('Missing').item.json.x }}" }],
            },
          }),
          node('B', 'core.set', { jsonOutput: '={{ $node["A"].json }}', mode: 'raw' }),
          node('Side', 'core.noOp', { note: "={{ $('B').item.json }}" }),
        ],
        connections: { ...link('Start', 'A'), ...link('A', 'B'), ...{} },
      },
      lookup,
    );
    expect(issues.find((i) => i.node === 'A' && /Missing/.test(i.message))?.severity).toBe('error');
    expect(issues.some((i) => i.node === 'B' && /"A"/.test(i.message))).toBe(false);
    expect(issues.find((i) => i.node === 'Side' && /not upstream/.test(i.message))?.severity).toBe('warning');
    expect(issues.find((i) => i.node === 'Side' && /no input connection/.test(i.message))?.severity).toBe(
      'warning',
    );
  });

  it('reports syntax errors in expressions', () => {
    const issues = lintWorkflow(
      {
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('A', 'core.set', { jsonOutput: '={{ $json.( }}', mode: 'raw' }),
        ],
        connections: link('Start', 'A'),
      },
      lookup,
    );
    expect(issues.some((i) => i.node === 'A' && /does not parse/.test(i.message))).toBe(true);
  });

  it('flags missing required parameters and credentials, unknown types and maxNodes', () => {
    const issues = lintWorkflow(
      {
        nodes: [
          node('T1', 'core.manualTrigger'),
          node('T2', 'core.manualTrigger'),
          node('Http', 'core.httpRequest', { url: '' }),
          node('Crm', 'app.crm', { resource: 'contact', operation: 'create', email: 'a@b.c' }),
          node('Mystery', 'vendor.unknown'),
        ],
        connections: { ...link('T1', 'Http'), ...link('Http', 'Crm'), ...link('Crm', 'Mystery') },
      },
      lookup,
    );
    const messages = issues.map((i) => `${i.node ?? ''}: ${i.message}`);
    expect(messages).toContain('Http: "URL" is required');
    expect(messages).toContain('Crm: Needs a "crmApi" credential');
    expect(messages.some((m) => m.startsWith('Mystery: Uses the node type "vendor.unknown"'))).toBe(true);
    expect(messages.some((m) => /can be used once per workflow, found 2/.test(m))).toBe(true);
    expect(issues[0].severity).toBe('error');
  });

  it('checks AI wiring and duplicate webhook routes', () => {
    const issues = lintWorkflow(
      {
        nodes: [
          node('Hook1', 'core.webhook', { path: 'orders', httpMethod: 'POST' }),
          node('Hook2', 'core.webhook', { path: 'orders', httpMethod: 'POST' }),
          node('Agent', 'ai.agent'),
          node('Memory', 'ai.memoryBuffer'),
        ],
        connections: link('Hook1', 'Agent'),
      },
      lookup,
    );
    const messages = issues.map((i) => `${i.node ?? ''}: ${i.message}`);
    expect(messages).toContain('Agent: Needs a "Chat Model" connection');
    expect(messages).toContain('Memory: Is not attached to a root node');
    expect(messages).toContain('Hook2: Listens on POST /orders, which "Hook1" already uses');
  });

  it('notes a missing trigger and pinned data on active workflows', () => {
    const issues = lintWorkflow(
      { nodes: [node('A', 'core.set')], connections: {}, pinData: { A: [{ json: {} }] }, active: true },
      lookup,
    );
    expect(issues.some((i) => i.severity === 'info' && /no trigger/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.severity === 'info' && /pinned data/.test(i.message))).toBe(true);
  });

  it('is quiet for a healthy workflow', () => {
    const issues = lintWorkflow(
      {
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Shape', 'core.set', {
            assignments: {
              assignments: [{ id: '1', name: 'x', type: 'string', value: "={{ $('Start').item.json.id }}" }],
            },
          }),
        ],
        connections: link('Start', 'Shape'),
      },
      lookup,
    );
    expect(issues).toEqual([]);
  });

  it('extracts references and expressions', () => {
    expect(
      referencedNodes(`={{ $('A').item.json.x + $node["B C"].json.y + $items("D") + $('E\\'s').first() }}`),
    ).toEqual(['A', "E's", 'B C', 'D']);
    expect(collectExpressions({ a: '=1', b: { c: ['x', '=2'] }, d: 3 })).toEqual([
      { path: 'a', expression: '=1' },
      { path: 'b.c[1]', expression: '=2' },
    ]);
  });
});
