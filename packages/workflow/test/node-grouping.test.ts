import { describe, expect, it } from 'vitest';
import {
  type Connections,
  expandSelectionWithSubNodes,
  GROUP_DESCRIPTION_MAX_LENGTH,
  type GroupingProblemCode,
  type NodeTypeDescription,
  normalizeGroupDescription,
  validateSelectionForExtraction,
  validateSelectionForGrouping,
  validateWorkflowNodeGroups,
  type WorkflowDefinition,
  type WorkflowNodeGroup,
} from '../src';

type Edge = [from: string, to: string, opts?: { type?: string; out?: number; in?: number }];

const TYPE: Record<string, Partial<NodeTypeDescription>> = {
  trigger: { group: ['trigger'] },
  poller: { group: ['transform'], polling: true },
  plain: { group: ['transform'] },
  old: { group: ['transform'], hidden: true },
  model: { group: ['transform'] },
};
const lookup = (type: string) =>
  TYPE[type] ? ({ name: type, ...TYPE[type] } as NodeTypeDescription) : undefined;

/** nodes: name -> type (id = lowercase name); edges by name */
function wf(
  nodes: Record<string, string>,
  edges: Edge[],
  groups: WorkflowNodeGroup[] = [],
): WorkflowDefinition {
  const connections: Connections = {};
  for (const [from, to, o] of edges) {
    const type = (o?.type ?? 'main') as 'main';
    const slot = (connections[from] ??= {});
    const lists = ((slot as Record<string, unknown[][]>)[type] ??= []);
    const out = o?.out ?? 0;
    while (lists.length <= out) lists.push([]);
    lists[out].push({ node: to, type, index: o?.in ?? 0 });
  }
  return {
    name: 'wf',
    nodes: Object.entries(nodes).map(([name, type], i) => ({
      id: name.toLowerCase(),
      name,
      type,
      typeVersion: 1,
      position: [i * 200, 0] as [number, number],
      parameters: {},
    })),
    connections,
    nodeGroups: groups,
  };
}
const codes = (p: Array<{ code: GroupingProblemCode }>) => p.map((x) => x.code).sort();
const sel = (d: WorkflowDefinition, ids: string[], ex = false) =>
  (ex ? validateSelectionForExtraction : validateSelectionForGrouping)(d, ids, lookup);

const line = wf({ T: 'trigger', A: 'plain', B: 'plain', C: 'plain', D: 'plain' }, [
  ['T', 'A'],
  ['A', 'B'],
  ['B', 'C'],
  ['C', 'D'],
]);

describe('grouping rules', () => {
  it('allows a connected chain and a single node', () => {
    expect(sel(line, ['a', 'b', 'c'])).toEqual([]);
    expect(sel(line, ['b'])).toEqual([]);
    expect(sel(line, ['c', 'd'])).toEqual([]);
  });
  it('blocks a trigger, with a message', () => {
    const p = sel(line, ['t', 'a']);
    expect(codes(p)).toEqual(['trigger']);
    expect(p[0].nodeIds).toEqual(['t']);
    expect(p[0].message).toMatch(/trigger/i);
  });
  it('treats a polling node as a trigger', () => {
    const d = wf({ P: 'poller', A: 'plain' }, [['P', 'A']]);
    expect(codes(sel(d, ['p', 'a']))).toEqual(['trigger']);
  });
  it('without a type lookup trigger checks are skipped', () => {
    expect(validateSelectionForGrouping(line, ['t', 'a'])).toEqual([]);
  });
  it('blocks a disconnected selection', () => {
    expect(codes(sel(line, ['a', 'c']))).toContain('disconnected');
  });
  it('blocks an empty selection', () => {
    expect(codes(sel(line, []))).toEqual(['generic']);
  });
  it('blocks more than one entry node', () => {
    const d = wf({ X: 'plain', Y: 'plain', M: 'plain', N: 'plain' }, [
      ['X', 'M'],
      ['Y', 'N'],
      ['M', 'N'],
    ]);
    expect(codes(sel(d, ['m', 'n']))).toEqual(['multiple_entry']);
  });
  it('allows many connections into the one entry node', () => {
    const d = wf({ X: 'plain', Y: 'plain', M: 'plain', N: 'plain' }, [
      ['X', 'M'],
      ['Y', 'M'],
      ['M', 'N'],
    ]);
    expect(sel(d, ['m', 'n'])).toEqual([]);
  });
  it('blocks more than one exit node', () => {
    const d = wf({ M: 'plain', N: 'plain', O: 'plain', P: 'plain' }, [
      ['M', 'N'],
      ['M', 'O'],
      ['N', 'P'],
    ]);
    expect(codes(sel(d, ['m', 'n']))).toEqual(['multiple_exit']);
  });
  it('allows many connections out of the one exit node', () => {
    const d = wf({ M: 'plain', N: 'plain', O: 'plain', P: 'plain' }, [
      ['M', 'N'],
      ['N', 'O'],
      ['N', 'P'],
    ]);
    expect(sel(d, ['m', 'n'])).toEqual([]);
  });
  it('blocks an input to a node that is not the first', () => {
    const d = wf({ X: 'plain', A: 'plain', B: 'plain' }, [
      ['A', 'B'],
      ['X', 'B'],
    ]);
    expect(codes(sel(d, ['a', 'b']))).toEqual(['input_to_non_first']);
  });
  it('blocks an output from a node that is not the last', () => {
    const d = wf({ A: 'plain', B: 'plain', X: 'plain' }, [
      ['A', 'B'],
      ['A', 'X'],
    ]);
    expect(codes(sel(d, ['a', 'b']))).toEqual(['output_from_non_last']);
  });
  it('allows a dangling branch end inside the section', () => {
    // E is fed from outside, F feeds outside; both are heads/tails of the selection but unrelated
    // except through H which points at both: heads {H}, tails {E, F}
    const d = wf({ X: 'plain', H: 'plain', E: 'plain', F: 'plain', Y: 'plain' }, [
      ['X', 'H'],
      ['H', 'E'],
      ['H', 'F'],
      ['F', 'Y'],
    ]);
    // entry H (head), exit F (not the only tail since E is also a tail) -> output_from_non_last
    expect(sel(d, ['h', 'e', 'f'])).toEqual([]);
    // one head, one tail, but the entry is the head and the exit the tail with a path: fine
    const ok = wf({ X: 'plain', H: 'plain', F: 'plain', Y: 'plain' }, [
      ['X', 'H'],
      ['H', 'F'],
      ['F', 'Y'],
    ]);
    expect(sel(ok, ['h', 'f'])).toEqual([]);
  });
  it('reports no_path_first_to_last when the entry cannot reach the exit', () => {
    // two loops: E<->G1 (fed from X) and F<->G2 (feeds Y); the only link goes G2 -> E
    const d = wf({ X: 'plain', E: 'plain', G1: 'plain', F: 'plain', G2: 'plain', Y: 'plain' }, [
      ['X', 'E'],
      ['E', 'G1'],
      ['G1', 'E'],
      ['F', 'G2'],
      ['G2', 'F'],
      ['G2', 'E'],
      ['F', 'Y'],
    ]);
    expect(codes(sel(d, ['e', 'g1', 'f', 'g2']))).toEqual(['no_path_first_to_last']);
  });
  it('blocks a non-main connection across the border (both directions)', () => {
    const d = wf({ Agent: 'plain', Model: 'model', Next: 'plain' }, [
      ['Model', 'Agent', { type: 'ai_languageModel' }],
      ['Agent', 'Next'],
    ]);
    const p = sel(d, ['model']);
    expect(codes(p)).toEqual(['non_main_boundary']);
    expect(p[0].nodeIds).toEqual(expect.arrayContaining(['model', 'agent']));
  });
  it('lets sub-nodes travel with a selected parent', () => {
    const d = wf({ In: 'plain', Agent: 'plain', Model: 'model', Out: 'plain' }, [
      ['In', 'Agent'],
      ['Model', 'Agent', { type: 'ai_languageModel' }],
      ['Agent', 'Out'],
    ]);
    expect(sel(d, ['agent'])).toEqual([]);
  });
  it('blocks a node already in another group', () => {
    const d = wf({ A: 'plain', B: 'plain' }, [['A', 'B']], [{ id: 'g1', name: 'Group', nodeIds: ['a'] }]);
    const p = sel(d, ['a', 'b']);
    expect(codes(p)).toEqual(['node_in_other_group']);
    expect(p[0].nodeIds).toEqual(['a']);
  });
  it('ignores sticky note ids in the selection', () => {
    const d = {
      ...line,
      stickyNotes: [{ id: 's1', content: '', position: [0, 0], width: 1, height: 1 }],
    } as WorkflowDefinition;
    expect(sel(d, ['a', 'b', 's1'])).toEqual([]);
  });
  it('never applies the single main input/output test', () => {
    const d = wf({ X: 'plain', Y: 'plain', M: 'plain', N: 'plain', O: 'plain' }, [
      ['X', 'M', { in: 0 }],
      ['Y', 'M', { in: 1 }],
      ['M', 'N', { out: 0 }],
      ['M', 'O', { out: 1 }],
    ]);
    expect(sel(d, ['m'])).toEqual([]);
  });
});

describe('extraction rules', () => {
  it('includes the grouping rules', () => {
    expect(codes(sel(line, ['t', 'a'], true))).toContain('trigger');
    expect(codes(sel(line, ['a', 'c'], true))).toContain('disconnected');
  });
  it('allows a chain with one input and one output', () => {
    expect(sel(line, ['b', 'c'], true)).toEqual([]);
  });
  it('blocks two input branches', () => {
    const d = wf({ X: 'plain', M: 'plain' }, [
      ['X', 'M', { in: 0 }],
      ['X', 'M', { in: 1 }],
    ]);
    expect(codes(sel(d, ['m'], true))).toEqual(['multiple_input_branches']);
    expect(sel(d, ['m'])).toEqual([]);
  });
  it('allows several sources feeding the same input', () => {
    const d = wf({ X: 'plain', Y: 'plain', M: 'plain' }, [
      ['X', 'M'],
      ['Y', 'M'],
    ]);
    expect(sel(d, ['m'], true)).toEqual([]);
  });
  it('blocks two output branches', () => {
    const d = wf({ M: 'plain', O: 'plain', P: 'plain' }, [
      ['M', 'O', { out: 0 }],
      ['M', 'P', { out: 1 }],
    ]);
    expect(codes(sel(d, ['m'], true))).toEqual(['multiple_output_branches']);
    expect(sel(d, ['m'])).toEqual([]);
  });
  it('blocks a deprecated (hidden) node', () => {
    const d = wf({ A: 'old', B: 'plain' }, [['A', 'B']]);
    const p = sel(d, ['a', 'b'], true);
    expect(codes(p)).toEqual(['deprecated']);
    expect(p[0].nodeIds).toEqual(['a']);
    expect(sel(d, ['a', 'b'])).toEqual([]);
  });
});

describe('expandSelectionWithSubNodes', () => {
  const d = wf({ Agent: 'plain', Model: 'model', Store: 'plain', Emb: 'model', Other: 'plain' }, [
    ['Model', 'Agent', { type: 'ai_languageModel' }],
    ['Store', 'Agent', { type: 'ai_tool' }],
    ['Emb', 'Store', { type: 'ai_embedding' }],
  ]);
  it('adds sub-nodes, recursively, selection first', () => {
    expect(expandSelectionWithSubNodes(d, ['agent'])).toEqual(['agent', 'model', 'store', 'emb']);
  });
  it('keeps the selection order and does not duplicate', () => {
    expect(expandSelectionWithSubNodes(d, ['store', 'agent', 'other'])).toEqual([
      'store',
      'agent',
      'other',
      'emb',
      'model',
    ]);
  });
  it('does not add parents of a selected sub-node', () => {
    expect(expandSelectionWithSubNodes(d, ['model'])).toEqual(['model']);
  });
});

describe('normalizeGroupDescription', () => {
  it('trims and returns undefined when empty', () => {
    expect(normalizeGroupDescription('  hi  ')).toBe('hi');
    expect(normalizeGroupDescription('   ')).toBeUndefined();
    expect(normalizeGroupDescription('')).toBeUndefined();
    expect(normalizeGroupDescription(null)).toBeUndefined();
    expect(normalizeGroupDescription(undefined)).toBeUndefined();
  });
});

describe('validateWorkflowNodeGroups', () => {
  const g = (id: string, name: string, nodeIds: string[], description?: string): WorkflowNodeGroup => ({
    id,
    name,
    nodeIds,
    ...(description === undefined ? {} : { description }),
  });
  const v = (groups: WorkflowNodeGroup[], types = true) =>
    validateWorkflowNodeGroups({ ...line, nodeGroups: groups }, types ? lookup : undefined);

  it('accepts no groups and valid groups', () => {
    expect(v([])).toEqual([]);
    expect(v([g('g1', 'Group', ['b', 'c']), g('g2', 'Group 2', ['d'])])).toEqual([]);
  });
  it('rejects a duplicate id', () => {
    expect(codes(v([g('g1', 'A', ['a']), g('g1', 'B', ['b'])]))).toEqual(['duplicate_group_id']);
  });
  it('rejects a duplicate name (exact match only)', () => {
    expect(codes(v([g('g1', 'A', ['a']), g('g2', 'A', ['b'])]))).toEqual(['duplicate_group_name']);
    expect(v([g('g1', 'A', ['a']), g('g2', 'a', ['b'])])).toEqual([]);
  });
  it('rejects an empty group', () => {
    expect(codes(v([g('g1', 'A', [])]))).toEqual(['empty_group']);
  });
  it('rejects an unknown node id', () => {
    const p = v([g('g1', 'A', ['a', 'zzz'])]);
    expect(codes(p)).toEqual(['unknown_node']);
    expect(p[0]).toMatchObject({ groupId: 'g1', nodeIds: ['zzz'] });
  });
  it('rejects a node in two groups', () => {
    const p = v([g('g1', 'A', ['a', 'b']), g('g2', 'B', ['b', 'c'])]);
    expect(codes(p)).toEqual(['node_in_multiple_groups', 'node_in_multiple_groups']);
    expect(p.map((x) => x.groupId)).toEqual(['g1', 'g2']);
    expect(p[0].nodeIds).toEqual(['b']);
  });
  it('rejects a description over the limit', () => {
    expect(codes(v([g('g1', 'A', ['a'], 'x'.repeat(GROUP_DESCRIPTION_MAX_LENGTH + 1))]))).toEqual([
      'description_too_long',
    ]);
    expect(v([g('g1', 'A', ['a'], 'x'.repeat(GROUP_DESCRIPTION_MAX_LENGTH))])).toEqual([]);
  });
  it('runs the full checks only when every member type resolves', () => {
    const groups = [g('g1', 'A', ['t', 'a'])];
    expect(codes(v(groups))).toEqual(['trigger']);
    expect(v(groups)[0].groupId).toBe('g1');
    expect(v(groups, false)).toEqual([]);
    const unknownType = {
      ...line,
      nodes: line.nodes.map((n) => (n.id === 'a' ? { ...n, type: 'mystery' } : n)),
      nodeGroups: groups,
    };
    expect(validateWorkflowNodeGroups(unknownType, lookup)).toEqual([]);
  });
  it('runs the full checks for each group (disconnected, boundary)', () => {
    expect(codes(v([g('g1', 'A', ['a', 'c'])]))).toContain('disconnected');
    const d = wf(
      { Agent: 'plain', Model: 'model' },
      [['Model', 'Agent', { type: 'ai_languageModel' }]],
      [g('g1', 'A', ['model'])],
    );
    expect(codes(validateWorkflowNodeGroups(d, lookup))).toEqual(['non_main_boundary']);
  });
  it('does not report node_in_other_group on top of node_in_multiple_groups', () => {
    const p = v([g('g1', 'A', ['a', 'b']), g('g2', 'B', ['b', 'c'])]);
    expect(codes(p)).not.toContain('node_in_other_group');
  });
  it('accepts a sticky note id as a member', () => {
    const d = {
      ...line,
      stickyNotes: [{ id: 's1', content: '', position: [0, 0], width: 1, height: 1 }],
      nodeGroups: [g('g1', 'A', ['b', 's1'])],
    } as WorkflowDefinition;
    expect(validateWorkflowNodeGroups(d, lookup)).toEqual([]);
  });
  it('treats missing nodeGroups as valid', () => {
    expect(validateWorkflowNodeGroups({ ...line, nodeGroups: undefined }, lookup)).toEqual([]);
  });
});
