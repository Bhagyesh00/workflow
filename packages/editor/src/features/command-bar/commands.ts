/**
 * The command bar's model (P3-01): the command registry, ranking, the workflow search query and the
 * rows each tab shows. No React in here, so the rules are testable on their own.
 *
 * Sources register their commands while they are on screen (the editor registers its set, the
 * shell registers navigation and the execution page's commands). The Nodes tab searches the node
 * catalogue with the same ranking as the node panel (lib/node-catalog.ts).
 */
import type { NodeParameters, NodeTypeDescription } from '@workflow/workflow';
import { create } from 'zustand';
import type { WorkflowSummary } from '../../api/types';
import { type CatalogEntry, filterCatalog } from '../../lib/node-catalog';

export const COMMAND_TABS = ['all', 'nodes', 'workflows', 'actions'] as const;
export type CommandTab = (typeof COMMAND_TABS)[number];

export const TAB_LABELS: Record<CommandTab, string> = {
  all: 'All',
  nodes: 'Nodes',
  workflows: 'Workflows',
  actions: 'Actions',
};

/** the search waits this long after the last key */
export const SEARCH_DEBOUNCE_MS = 300;
/** every source shows this many rows on All, then a "Show all" row */
export const PREVIEW_LIMIT = 5;
/** page size of a single tab, and of "Load more" */
export const PAGE_SIZE = 20;

export interface CommandRunContext {
  /** Ctrl/Cmd+Enter: open the result in a new tab when it has an address */
  newTab: boolean;
  /** switch the bar to a tab and keep it open */
  goToTab(tab: CommandTab): void;
}

export interface Command {
  id: string;
  title: string;
  /** small label next to the title (a node's type, a section) */
  description?: string;
  /** extra words that find the command */
  keywords?: string[];
  /** an app address the command opens: Ctrl/Cmd+Enter opens it in a new tab */
  path?: string;
  /** a second level: choosing the command shows these (Backspace on an empty query goes back) */
  children?: () => Command[];
  /** leave the bar open after the command ran (it closes first otherwise) */
  keepOpen?: boolean;
  run?: (ctx: CommandRunContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export type NodeAdder = (description: NodeTypeDescription, parameters?: NodeParameters) => string | null;

interface RegistryState {
  sources: Record<string, Command[]>;
  /** set while a workflow is open for editing */
  nodeAdder: NodeAdder | null;
  register(source: string, commands: Command[]): () => void;
  setNodeAdder(adder: NodeAdder | null): void;
}

export const useCommandRegistry = create<RegistryState>()((set) => ({
  sources: {},
  nodeAdder: null,
  register(source, commands) {
    set((s) => ({ sources: { ...s.sources, [source]: commands } }));
    return () =>
      set((s) => {
        if (s.sources[source] !== commands) return s;
        const { [source]: _gone, ...rest } = s.sources;
        return { sources: rest };
      });
  },
  setNodeAdder(adder) {
    set({ nodeAdder: adder });
  },
}));

export function registerCommands(source: string, commands: Command[]): () => void {
  return useCommandRegistry.getState().register(source, commands);
}

/** every registered command, the editor's first (they are the most specific) */
export function allCommands(sources: Record<string, Command[]>): Command[] {
  const names = Object.keys(sources).sort((a, b) => Number(b === 'editor') - Number(a === 'editor'));
  return names.flatMap((name) => sources[name]);
}

// ---------------------------------------------------------------------------------------------
// Ranking and search
// ---------------------------------------------------------------------------------------------

function score(command: Command, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const title = command.title.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 50;
  if (command.keywords?.some((k) => k.toLowerCase().includes(q))) return 30;
  if (command.description?.toLowerCase().includes(q)) return 20;
  return 0;
}

/** Best match first; ties keep their registered order. An empty query keeps everything in order. */
export function rankCommands(commands: Command[], query: string): Command[] {
  return commands
    .map((command, index) => ({ command, index, score: score(command, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((c) => c.command);
}

export interface WorkflowSearch {
  search: string;
  /** node types whose display name equals the query: workflows holding one are found too */
  nodeTypes: string[];
  matchTags: true;
}

/**
 * The /workflows search for a query: the name, workflows holding a node whose type display name
 * equals the query (at most 20 types), and workflows tagged with a tag named like the query.
 */
export function workflowSearch(query: string, catalog: CatalogEntry[]): WorkflowSearch {
  const search = query.trim();
  const q = search.toLowerCase();
  const nodeTypes = q
    ? catalog
        .filter((e) => e.description.displayName.toLowerCase() === q)
        .map((e) => e.description.name)
        .slice(0, 20)
    : [];
  return { search, nodeTypes, matchTags: true };
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type SourceTab = Exclude<CommandTab, 'all'>;

export type Row =
  | { kind: 'command'; key: string; command: Command }
  | { kind: 'node'; key: string; entry: CatalogEntry }
  | { kind: 'workflow'; key: string; workflow: WorkflowSummary }
  | { kind: 'show-all'; key: string; tab: SourceTab; label: string }
  | { kind: 'load-more'; key: string; tab: SourceTab; label: string };

export interface RowSection {
  title: string;
  rows: Row[];
}

export interface RowInput {
  tab: CommandTab;
  /** the (debounced) query */
  query: string;
  commands: Command[];
  catalog: CatalogEntry[];
  /** whether a workflow is open for editing: only then can nodes be added */
  canAddNodes: boolean;
  /** workflows found so far for the query (newest first), and whether the server has more */
  workflows: WorkflowSummary[];
  workflowsHasMore: boolean;
  /** how many rows of a single tab are shown (grows by PAGE_SIZE with "Load more") */
  visible: Record<SourceTab, number>;
}

function nodeEntries(catalog: CatalogEntry[], query: string): CatalogEntry[] {
  return filterCatalog(catalog, { query }).flatMap((section) => section.entries);
}

/** The sections of the list for a tab. Empty query on All: recent workflows, then the actions. */
export function buildSections(input: RowInput): RowSection[] {
  const { tab, query } = input;
  const typed = query.trim().length > 0;
  const commands = rankCommands(input.commands, query);
  const nodes = input.canAddNodes ? nodeEntries(input.catalog, query) : [];
  const commandRow = (command: Command): Row => ({ kind: 'command', key: `command:${command.id}`, command });
  const nodeRow = (entry: CatalogEntry): Row => ({
    kind: 'node',
    key: `node:${entry.description.name}`,
    entry,
  });
  const workflowRow = (workflow: WorkflowSummary): Row => ({
    kind: 'workflow',
    key: `workflow:${workflow.id}`,
    workflow,
  });

  if (tab === 'all') {
    const sections: RowSection[] = [];
    const preview = <T>(
      title: string,
      list: T[],
      toRow: (item: T) => Row,
      source: SourceTab,
      label: string,
      more = false,
    ) => {
      if (!list.length) return;
      const rows = list.slice(0, PREVIEW_LIMIT).map(toRow);
      if (list.length > PREVIEW_LIMIT || more)
        rows.push({ kind: 'show-all', key: `show-all:${source}`, tab: source, label });
      sections.push({ title, rows });
    };
    const moreWorkflows = input.workflowsHasMore;
    if (typed) {
      preview('Actions', commands, commandRow, 'actions', 'Show all actions');
      preview('Nodes', nodes, nodeRow, 'nodes', 'Show all nodes');
      preview('Workflows', input.workflows, workflowRow, 'workflows', 'Show all workflows', moreWorkflows);
    } else {
      preview(
        'Recent workflows',
        input.workflows,
        workflowRow,
        'workflows',
        'Show all workflows',
        moreWorkflows,
      );
      preview('Actions', commands, commandRow, 'actions', 'Show all actions');
    }
    return sections;
  }

  const paged = <T>(list: T[], source: SourceTab, toRow: (item: T) => Row, more: boolean, label: string) => {
    const rows = list.slice(0, input.visible[source]).map(toRow);
    if (list.length > rows.length || more)
      rows.push({ kind: 'load-more', key: `load-more:${source}`, tab: source, label });
    return rows;
  };
  if (tab === 'actions')
    return commands.length
      ? [{ title: 'Actions', rows: paged(commands, 'actions', commandRow, false, 'Load more') }]
      : [];
  if (tab === 'nodes')
    return nodes.length ? [{ title: 'Nodes', rows: paged(nodes, 'nodes', nodeRow, false, 'Load more') }] : [];
  return input.workflows.length
    ? [
        {
          title: typed ? 'Workflows' : 'Recent workflows',
          rows: paged(input.workflows, 'workflows', workflowRow, input.workflowsHasMore, 'Load more'),
        },
      ]
    : [];
}

/** The rows of a second level (a command's children): one list, ranked, in pages. */
export function buildLevelSections(
  commands: Command[],
  query: string,
  title: string,
  visible: number,
): RowSection[] {
  const ranked = rankCommands(commands, query);
  if (!ranked.length) return [];
  const rows: Row[] = ranked
    .slice(0, visible)
    .map((command) => ({ kind: 'command', key: `command:${command.id}`, command }));
  if (ranked.length > visible)
    rows.push({ kind: 'load-more', key: 'load-more:actions', tab: 'actions', label: 'Load more' });
  return [{ title, rows }];
}

export function flatRows(sections: RowSection[]): Row[] {
  return sections.flatMap((s) => s.rows);
}

/** Tab / Shift+Tab (and the arrows at the caret edges): the next tab, wrapping around. */
export function cycleTab(tab: CommandTab, direction: 1 | -1): CommandTab {
  const index = COMMAND_TABS.indexOf(tab);
  return COMMAND_TABS[(index + direction + COMMAND_TABS.length) % COMMAND_TABS.length];
}

/** Ctrl/Cmd+K stays closed over another modal dialog (the bar itself does not count). */
export function modalOpenElsewhere(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]:not([data-command-bar])'));
}
