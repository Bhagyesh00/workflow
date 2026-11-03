/** P3-01: the command bar's model (registry, ranking, workflow search, rows, tabs). */
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowSummary } from '../src/api/types';
import { demoNodeTypes } from '../src/demo/fixtures';
import {
  allCommands,
  buildLevelSections,
  buildSections,
  type Command,
  cycleTab,
  flatRows,
  modalOpenElsewhere,
  PAGE_SIZE,
  PREVIEW_LIMIT,
  type RowInput,
  rankCommands,
  registerCommands,
  useCommandRegistry,
  workflowSearch,
} from '../src/features/command-bar/commands';
import { buildCatalog } from '../src/lib/node-catalog';

const catalog = buildCatalog(demoNodeTypes);

function command(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, ...extra };
}

function workflow(n: number): WorkflowSummary {
  return {
    id: `w${n}`,
    name: `Flow ${n}`,
    active: false,
    tags: [],
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    nodeTypes: [],
    isArchived: false,
    folderId: null,
    publishedVersionId: null,
  };
}

function input(over: Partial<RowInput> = {}): RowInput {
  return {
    tab: 'all',
    query: '',
    commands: [],
    catalog,
    canAddNodes: true,
    workflows: [],
    workflowsHasMore: false,
    visible: { nodes: PAGE_SIZE, workflows: PAGE_SIZE, actions: PAGE_SIZE },
    ...over,
  };
}

afterEach(() => {
  useCommandRegistry.setState({ sources: {}, nodeAdder: null });
  document.body.innerHTML = '';
});

describe('rankCommands', () => {
  const list = [
    command('a', 'Download workflow'),
    command('b', 'Workflow settings'),
    command('c', 'Go to Workflows'),
    command('d', 'Select all', { keywords: ['workflow'] }),
  ];

  it('keeps everything in order for an empty query', () => {
    expect(rankCommands(list, '  ').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ranks a title that starts with the query before one that contains it, then keywords', () => {
    expect(rankCommands(list, 'workflow').map((c) => c.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(rankCommands(list, 'zzz')).toEqual([]);
  });

  it('matches a description and ranks an exact title first', () => {
    const more = [command('x', 'Open', { description: 'Workflows' }), command('y', 'Workflows')];
    expect(rankCommands(more, 'workflows').map((c) => c.id)).toEqual(['y', 'x']);
  });
});

describe('workflowSearch', () => {
  it('adds the node types whose display name equals the query, and asks for tag matches', () => {
    const set = demoNodeTypes.find((d) => d.name === 'core.set');
    expect(set).toBeTruthy();
    const found = workflowSearch(`  ${set?.displayName.toUpperCase()} `, catalog);
    expect(found.nodeTypes).toContain('core.set');
    expect(found.matchTags).toBe(true);
    expect(found.search).toBe(set?.displayName.toUpperCase());
  });

  it('adds no node type for a partial name or an empty query', () => {
    expect(workflowSearch('edit', catalog).nodeTypes).toEqual([]);
    expect(workflowSearch('', catalog).nodeTypes).toEqual([]);
  });
});

describe('buildSections', () => {
  const commands = Array.from({ length: 8 }, (_, i) => command(`c${i}`, `Action ${i}`));

  it('an empty query on All lists recent workflows, then the actions, 5 each with Show all', () => {
    const sections = buildSections(
      input({ commands, workflows: Array.from({ length: 7 }, (_, i) => workflow(i)) }),
    );
    expect(sections.map((s) => s.title)).toEqual(['Recent workflows', 'Actions']);
    expect(sections[0].rows).toHaveLength(PREVIEW_LIMIT + 1);
    expect(sections[0].rows.at(-1)).toMatchObject({ kind: 'show-all', tab: 'workflows' });
    expect(sections[1].rows.at(-1)).toMatchObject({ kind: 'show-all', tab: 'actions' });
  });

  it('shows no Show all row when a source fits in 5', () => {
    const sections = buildSections(input({ commands: commands.slice(0, 3) }));
    expect(sections).toHaveLength(1);
    expect(sections[0].rows.map((r) => r.kind)).toEqual(['command', 'command', 'command']);
  });

  it('a typed query lists actions, nodes, then workflows', () => {
    const sections = buildSections(
      input({
        query: 'set',
        commands: [command('s', 'Workflow settings')],
        workflows: [workflow(1)],
      }),
    );
    expect(sections.map((s) => s.title)).toEqual(['Actions', 'Nodes', 'Workflows']);
    const nodes = sections[1].rows.filter((r) => r.kind === 'node');
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('leaves nodes out when no workflow is open for editing', () => {
    const sections = buildSections(input({ query: 'set', canAddNodes: false }));
    expect(sections.find((s) => s.title === 'Nodes')).toBeUndefined();
  });

  it('the Nodes tab pages by 20 with a Load more row, and shows more when asked', () => {
    const first = buildSections(input({ tab: 'nodes' }));
    expect(first[0].rows.filter((r) => r.kind === 'node')).toHaveLength(
      Math.min(PAGE_SIZE, flatRows(first).filter((r) => r.kind === 'node').length),
    );
    const many = Array.from({ length: 25 }, (_, i) => command(`m${i}`, `Many ${i}`));
    const page1 = buildSections(input({ tab: 'actions', commands: many }));
    expect(page1[0].rows).toHaveLength(PAGE_SIZE + 1);
    expect(page1[0].rows.at(-1)).toMatchObject({ kind: 'load-more', tab: 'actions' });
    const page2 = buildSections(
      input({ tab: 'actions', commands: many, visible: { nodes: 20, workflows: 20, actions: 40 } }),
    );
    expect(page2[0].rows).toHaveLength(25);
  });

  it('the Workflows tab offers Load more while the server has another page', () => {
    const sections = buildSections(
      input({
        tab: 'workflows',
        workflows: Array.from({ length: PAGE_SIZE }, (_, i) => workflow(i)),
        workflowsHasMore: true,
      }),
    );
    expect(sections[0].rows.at(-1)).toMatchObject({ kind: 'load-more', tab: 'workflows' });
  });

  it('gives no section for an empty result', () => {
    expect(buildSections(input({ tab: 'actions', query: 'nothing matches this' }))).toEqual([]);
  });
});

describe('levels and tabs', () => {
  it('a level ranks its own commands', () => {
    const sections = buildLevelSections(
      [command('a', 'Alpha'), command('b', 'Beta')],
      'be',
      'Nodes in workflow',
      20,
    );
    expect(sections[0].title).toBe('Nodes in workflow');
    expect(sections[0].rows).toHaveLength(1);
  });

  it('Tab cycles All, Nodes, Workflows, Actions and wraps', () => {
    expect(cycleTab('all', 1)).toBe('nodes');
    expect(cycleTab('actions', 1)).toBe('all');
    expect(cycleTab('all', -1)).toBe('actions');
  });
});

describe('registry', () => {
  it('lists the editor commands first, and removes a source when it unregisters', () => {
    const offApp = registerCommands('app', [command('a', 'App')]);
    const offEditor = registerCommands('editor', [command('e', 'Editor')]);
    expect(allCommands(useCommandRegistry.getState().sources).map((c) => c.id)).toEqual(['e', 'a']);
    offEditor();
    expect(allCommands(useCommandRegistry.getState().sources).map((c) => c.id)).toEqual(['a']);
    offApp();
    expect(useCommandRegistry.getState().sources).toEqual({});
  });

  it('a stale unregister does not remove the newer commands of the same source', () => {
    const off = registerCommands('editor', [command('one', 'One')]);
    registerCommands('editor', [command('two', 'Two')]);
    off();
    expect(allCommands(useCommandRegistry.getState().sources).map((c) => c.id)).toEqual(['two']);
  });
});

describe('modalOpenElsewhere', () => {
  it('sees another aria-modal dialog but not the command bar itself', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true" data-command-bar=""></div>';
    expect(modalOpenElsewhere()).toBe(false);
    document.body.innerHTML += '<div role="dialog" aria-modal="true"></div>';
    expect(modalOpenElsewhere()).toBe(true);
  });
});
