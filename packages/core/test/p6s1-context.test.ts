import type { NodeType } from '@workflow/workflow';
import { Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { NodeTypes, WorkflowExecute } from '../src';
import type { ExecutionServices } from '../src/engine/services';
import { connect, node, services, testNodes } from './helpers';

// Phase 6 S1 run contract: a node reads the project its workflow runs in from the services the server builds
const probe: NodeType = {
  description: {
    name: 'test.projectProbe',
    displayName: 'Project probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Probe' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    return [[{ json: { projectId: ctx.getProjectId(), tenantId: ctx.getTenantId() } }]];
  },
};

const types = new NodeTypes([...testNodes, probe]);

function run(overrides: Partial<ExecutionServices>) {
  const workflow = new Workflow(
    {
      id: 'w1',
      name: 'Project probe',
      active: false,
      nodes: [node('Trigger', 'test.trigger'), node('Probe', 'test.projectProbe')],
      connections: connect(['Trigger', 'Probe']),
      settings: {},
    },
    types,
  );
  return new WorkflowExecute(workflow, services({ nodeTypes: types, ...overrides })).run();
}

const probeJson = (result: Awaited<ReturnType<typeof run>>) =>
  result.state.resultData.runData.Probe?.[0]?.data?.main?.[0]?.[0]?.json;

describe('p6s1 node context', () => {
  it('getProjectId returns the project of the services the run was built with', async () => {
    const result = await run({ tenantId: 't1', projectId: 'project-a' });
    expect(probeJson(result)).toEqual({ projectId: 'project-a', tenantId: 't1' });
  });

  it('each run reads its own project', async () => {
    const [a, b] = await Promise.all([run({ projectId: 'project-a' }), run({ projectId: 'project-b' })]);
    expect(probeJson(a)?.projectId).toBe('project-a');
    expect(probeJson(b)?.projectId).toBe('project-b');
  });

  it('the test services carry a project, so every hand-built context has one', () => {
    expect(services().projectId).toBe('p1');
  });
});
