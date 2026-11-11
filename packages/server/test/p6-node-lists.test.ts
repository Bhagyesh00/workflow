/** P6-47 (L3) NODES_EXCLUDE and NODES_INCLUDE applied by buildRegistries. */
import type { NodePackage, NodeType } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { buildRegistries } from '../src/node-packages';

const mk = (name: string, tool = false): NodeType => ({
  description: {
    name,
    displayName: name,
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
    ...(tool ? { usableAsTool: true } : {}),
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
});
const pkg: NodePackage = {
  name: 'p6-lists',
  nodes: [mk('p6.a', true), mk('p6.b'), mk('p6.c')],
  credentials: [],
};
const names = (l?: { exclude: string[]; include: string[] }) =>
  buildRegistries([pkg], l)
    .nodeTypes.list()
    .map((n) => n.description.name);

describe('node lists', () => {
  it('default empty lists keep everything, with the tool variant', () => {
    const all = names({ exclude: [], include: [] });
    expect(all).toContain('p6.a');
    expect(all).toContain('p6.aTool');
    expect(names()).toEqual(all);
  });
  it('exclude removes a node and its variant', () => {
    const n = names({ exclude: ['p6.a'], include: [] });
    expect(n).not.toContain('p6.a');
    expect(n).not.toContain('p6.aTool');
    expect(n).toContain('p6.b');
  });
  it('a variant alone can be excluded; the base stays', () => {
    const n = names({ exclude: ['p6.aTool'], include: [] });
    expect(n).toContain('p6.a');
    expect(n).not.toContain('p6.aTool');
  });
  it('include narrows to the named nodes', () => {
    const n = names({ exclude: [], include: ['p6.b', 'p6.a'] });
    expect(n.filter((x) => x.startsWith('p6.')).sort()).toEqual(['p6.a', 'p6.aTool', 'p6.b']);
  });
  it('exclude wins over include', () => {
    expect(
      names({ exclude: ['p6.b'], include: ['p6.b', 'p6.c'] }).filter((x) => x.startsWith('p6.')),
    ).toEqual(['p6.c']);
  });
});
