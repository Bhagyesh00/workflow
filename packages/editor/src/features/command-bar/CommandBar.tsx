/**
 * The command bar (P3-01, as n8n N8nCommandBar): Ctrl/Cmd+K opens and closes it (also from inputs;
 * stays closed over another aria-modal dialog), tabs All / Nodes / Workflows / Actions, search with
 * 300 ms debounce and pages of 20. Mounted once in AppShell; reads ui.commandBarOpen.
 *
 * Keys: Arrow up / down move, Enter chooses, Ctrl/Cmd+Enter opens a result in a new tab, Tab /
 * Shift+Tab (and Arrow left / right at the caret edges) switch tabs, Backspace or Arrow left on an
 * empty query goes back a level, Esc closes. The model lives in commands.ts.
 */
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CornerDownLeft, Search } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHref, useMatch, useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { executionsApi, workflowsApi } from '../../api/endpoints';
import { queryKeys, useMe, useNodeTypes } from '../../api/queries';
import { cx } from '../../components/ui/cx';
import { Spinner } from '../../components/ui/misc';
import { buildCatalog } from '../../lib/node-catalog';
import { toast, useUiStore } from '../../stores/ui-store';
import {
  debugExecution,
  deleteExecution,
  retryExecution,
  stopExecution,
} from '../executions/execution-commands';
import {
  allCommands,
  buildLevelSections,
  buildSections,
  COMMAND_TABS,
  type Command,
  type CommandTab,
  cycleTab,
  flatRows,
  modalOpenElsewhere,
  PAGE_SIZE,
  type Row,
  registerCommands,
  SEARCH_DEBOUNCE_MS,
  type SourceTab,
  TAB_LABELS,
  useCommandRegistry,
  workflowSearch,
} from './commands';

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// Commands of the app shell: navigation, new workflow, and the open execution's commands
// ---------------------------------------------------------------------------------------------

function useShellCommands(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const viewer = useMe().data?.role === 'viewer';
  const inEditor = Boolean(useMatch('/workflow/:id'));
  const executionId = useMatch('/executions/:id')?.params.id;
  const execution = useQuery({
    queryKey: queryKeys.execution(executionId ?? ''),
    queryFn: () => executionsApi.get(executionId ?? ''),
    enabled: Boolean(executionId),
    retry: false,
  });
  const status = execution.data?.status;
  const workflowId = execution.data?.workflowId;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'open-workflow',
        title: 'Open workflow',
        description: 'Workflows',
        keywords: ['find workflow', 'search workflows'],
        keepOpen: true,
        run: ({ goToTab }) => goToTab('workflows'),
      },
    ];
    if (!viewer) {
      list.push({
        id: 'new-workflow',
        title: 'New workflow',
        description: 'Workflows',
        keywords: ['create'],
        path: '/workflow/new',
        run: () => navigate('/workflow/new'),
      });
      // the editor registers its own Import from file
      if (!inEditor)
        list.push({
          id: 'import-file',
          title: 'Import from file',
          description: 'Workflows',
          keywords: ['upload', 'json'],
          run: () => {
            useUiStore.getState().setImportOpen(true);
            navigate('/workflows');
          },
        });
    }
    for (const [id, title, path] of [
      ['go-workflows', 'Go to Workflows', '/workflows'],
      ['go-executions', 'Go to Executions', '/executions'],
      ['go-credentials', 'Go to Credentials', '/credentials'],
      ['go-data-tables', 'Go to Data tables', '/data-tables'],
      ['go-settings', 'Go to Settings', '/settings'],
    ] as const) {
      list.push({ id, title, description: 'Navigate', path, run: () => navigate(path) });
    }
    return list;
  }, [navigate, viewer, inEditor]);
  useEffect(() => registerCommands('app', commands), [commands]);

  const executionCommands = useMemo<Command[]>(() => {
    if (!executionId || !status) return [];
    const deps = { navigate: (to: string) => navigate(to), queryClient };
    const section = 'Execution';
    const list: Command[] = [];
    const finished = !['running', 'waiting', 'new'].includes(status);
    if (workflowId && finished)
      list.push({
        id: 'debug-execution',
        title: 'Debug in editor',
        description: section,
        keywords: ['replay', 'pin'],
        run: () => debugExecution(workflowId, executionId, deps),
      });
    if (!viewer) {
      const vote = (value: 'up' | 'down') => async () => {
        try {
          await executionsApi.annotate(executionId, { vote: value });
          await queryClient.invalidateQueries({ queryKey: queryKeys.execution(executionId) });
          await queryClient.invalidateQueries({ queryKey: ['executions'] });
          toast.success('Vote saved');
        } catch (error) {
          toast.error('Could not save the vote', errorMessage(error));
        }
      };
      list.push(
        {
          id: 'vote-up',
          title: 'Vote up',
          description: section,
          keywords: ['good', 'rate'],
          run: vote('up'),
        },
        {
          id: 'vote-down',
          title: 'Vote down',
          description: section,
          keywords: ['bad', 'rate'],
          run: vote('down'),
        },
      );
      if (['error', 'crashed', 'canceled'].includes(status))
        list.push(
          {
            id: 'retry-current',
            title: 'Retry with current workflow',
            description: section,
            run: async () => {
              await retryExecution(executionId, true, deps);
            },
          },
          {
            id: 'retry-original',
            title: 'Retry with original workflow',
            description: section,
            run: async () => {
              await retryExecution(executionId, false, deps);
            },
          },
        );
      if (!finished)
        list.push({
          id: 'stop-execution',
          title: 'Stop execution',
          description: section,
          keywords: ['cancel'],
          run: async () => {
            await stopExecution(executionId, deps);
          },
        });
      list.push({
        id: 'delete-execution',
        title: 'Delete execution',
        description: section,
        keywords: ['remove'],
        run: async () => {
          await deleteExecution(executionId, deps);
        },
      });
    }
    return list;
  }, [executionId, status, workflowId, viewer, navigate, queryClient]);
  useEffect(() => registerCommands('execution', executionCommands), [executionCommands]);
}

// ---------------------------------------------------------------------------------------------
// Ctrl/Cmd+K
// ---------------------------------------------------------------------------------------------

function useCommandBarHotkey(): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'k') return;
      // the browser's own Ctrl+K (search) never fires, also from inputs
      event.preventDefault();
      const ui = useUiStore.getState();
      if (ui.commandBarOpen) ui.setCommandBarOpen(false);
      else if (!modalOpenElsewhere()) ui.setCommandBarOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

// ---------------------------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------------------------

interface Level {
  title: string;
  commands: Command[];
}

const PANEL_ID = 'command-bar';

function CommandBarPanel() {
  const navigate = useNavigate();
  const homeHref = useHref('/');
  const nodeTypes = useNodeTypes();
  const sources = useCommandRegistry((s) => s.sources);
  const nodeAdder = useCommandRegistry((s) => s.nodeAdder);
  const close = useCallback(() => useUiStore.getState().setCommandBarOpen(false), []);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tab, setTab] = useState<CommandTab>('all');
  const [levels, setLevels] = useState<Level[]>([]);
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState<Record<SourceTab, number>>({
    nodes: PAGE_SIZE,
    workflows: PAGE_SIZE,
    actions: PAGE_SIZE,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const level = levels[levels.length - 1];

  // focus the input, and give the focus back on close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Esc closes from anywhere in the bar
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  // the workflow search waits for the typing to stop (an empty query shows at once)
  useEffect(() => {
    if (!query.trim()) {
      setDebounced('');
      return;
    }
    const timer = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const catalog = useMemo(() => buildCatalog(nodeTypes.list), [nodeTypes.list]);
  const search = useMemo(() => workflowSearch(debounced, catalog), [debounced, catalog]);
  const wantWorkflows = !level && (tab === 'all' || tab === 'workflows');
  const workflowQuery = useInfiniteQuery({
    queryKey: ['workflows', { commandBar: true, ...search }],
    enabled: wantWorkflows,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      workflowsApi.list({
        search: search.search || undefined,
        nodeTypes: search.nodeTypes,
        matchTags: search.search ? true : undefined,
        archived: 'false',
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const workflows = useMemo(
    () => workflowQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [workflowQuery.data],
  );
  const workflowsHasMore = Boolean(workflowQuery.hasNextPage);
  const pending = query.trim() !== debounced.trim();

  const sections = useMemo(() => {
    if (level) return buildLevelSections(level.commands, query, level.title, visible.actions);
    return buildSections({
      tab,
      query,
      commands: allCommands(sources),
      catalog,
      canAddNodes: nodeAdder !== null,
      workflows,
      workflowsHasMore,
      visible,
    });
  }, [level, query, tab, sources, catalog, nodeAdder, workflows, workflowsHasMore, visible]);
  const rows = useMemo(() => flatRows(sections), [sections]);

  // a new list starts at its first row
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs that reset the cursor
  useEffect(() => setActive(0), [query, tab, levels.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const switchTab = useCallback((next: CommandTab) => {
    setTab(next);
    setVisible({ nodes: PAGE_SIZE, workflows: PAGE_SIZE, actions: PAGE_SIZE });
  }, []);
  const back = useCallback(() => {
    setLevels((l) => l.slice(0, -1));
    setQuery('');
    setVisible((v) => ({ ...v, actions: PAGE_SIZE }));
  }, []);
  const loadMore = useCallback(
    (source: SourceTab) => {
      setVisible((v) => ({ ...v, [source]: v[source] + PAGE_SIZE }));
      if (source === 'workflows' && workflowQuery.hasNextPage) void workflowQuery.fetchNextPage();
    },
    [workflowQuery],
  );

  const openInNewTab = (path: string) => {
    window.open(`${homeHref.slice(0, -1)}${path}`, '_blank', 'noopener,noreferrer');
  };

  const activate = async (row: Row | undefined, newTab: boolean) => {
    if (!row) return;
    if (row.kind === 'show-all') {
      switchTab(row.tab);
      return;
    }
    if (row.kind === 'load-more') {
      loadMore(row.tab);
      return;
    }
    if (row.kind === 'workflow') {
      // the list still answers an earlier query while the typing is settling
      if (pending) return;
      const path = `/workflow/${enc(row.workflow.id)}`;
      close();
      if (newTab) openInNewTab(path);
      else navigate(path);
      return;
    }
    if (row.kind === 'node') {
      close();
      if (!nodeAdder) return;
      try {
        // the node panel may still be in replace mode (R); a node picked here is added, never swapped in
        const ui = useUiStore.getState();
        if (ui.replaceTarget) ui.setSidePanel(null);
        nodeAdder(row.entry.description);
      } catch (error) {
        toast.error(`Could not add ${row.entry.description.displayName}`, errorMessage(error));
      }
      return;
    }
    const command = row.command;
    if (command.children) {
      setLevels((l) => [...l, { title: command.title, commands: command.children?.() ?? [] }]);
      setQuery('');
      setVisible((v) => ({ ...v, actions: PAGE_SIZE }));
      return;
    }
    if (!command.keepOpen) close();
    if (newTab && command.path) {
      openInNewTab(command.path);
      return;
    }
    try {
      await command.run?.({ newTab, goToTab: switchTab });
    } catch (error) {
      toast.error(`Could not run “${command.title}”`, errorMessage(error));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    const count = rows.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count) setActive((a) => (a + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count) setActive((a) => (a - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        void activate(rows[active], event.ctrlKey || event.metaKey);
        break;
      case 'Tab':
        event.preventDefault();
        if (!level) switchTab(cycleTab(tab, event.shiftKey ? -1 : 1));
        break;
      case 'ArrowRight':
        if (!level && atEnd) {
          event.preventDefault();
          switchTab(cycleTab(tab, 1));
        }
        break;
      case 'ArrowLeft':
        if (level && !query) {
          event.preventDefault();
          back();
        } else if (!level && atStart) {
          event.preventDefault();
          switchTab(cycleTab(tab, -1));
        }
        break;
      case 'Backspace':
        if (level && !query) {
          event.preventDefault();
          back();
        }
        break;
    }
  };

  const loading = wantWorkflows && workflowQuery.isFetching && !workflowQuery.isFetchingNextPage;
  const emptyText = !rows.length
    ? tab === 'nodes' && !nodeAdder && !level
      ? 'Open a workflow to add nodes.'
      : query.trim()
        ? `No results for “${query.trim()}”.`
        : 'Nothing to show.'
    : '';
  let index = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-[color-mix(in_oklab,var(--wf-ink)_38%,transparent)] p-4 pt-[12vh] backdrop-blur-[2px]"
      data-testid="command-bar"
    >
      <button
        type="button"
        aria-label="Close the command bar"
        tabIndex={-1}
        className="fixed inset-0 cursor-default"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        data-command-bar=""
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lift"
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          {level ? (
            <button
              type="button"
              onClick={back}
              className="shrink-0 rounded-md bg-surface-3 px-2 py-0.5 text-xs font-medium text-ink-2 hover:text-ink"
              aria-label={`Back from ${level.title}`}
            >
              {level.title}
            </button>
          ) : (
            <Search size={16} className="shrink-0 text-ink-3" aria-hidden />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${PANEL_ID}-list`}
            aria-activedescendant={rows.length ? `${PANEL_ID}-row-${active}` : undefined}
            aria-label="Search the command bar"
            placeholder={
              level ? `Search ${level.title.toLowerCase()}` : 'Search nodes, workflows and actions'
            }
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          {loading && <Spinner size={14} />}
        </div>
        {!level && (
          <div role="tablist" aria-label="Show" className="flex gap-1 border-b border-line px-3 py-1.5">
            {COMMAND_TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                tabIndex={-1}
                onClick={() => {
                  switchTab(id);
                  inputRef.current?.focus();
                }}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  tab === id ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                )}
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </div>
        )}
        <div
          ref={listRef}
          id={`${PANEL_ID}-list`}
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {sections.map((section) => (
            <div key={section.title} role="presentation" className="mb-1">
              <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                {section.title}
              </p>
              {section.rows.map((row) => {
                index += 1;
                const i = index;
                return (
                  <ResultRow
                    key={row.key}
                    row={row}
                    id={`${PANEL_ID}-row-${i}`}
                    index={i}
                    selected={i === active}
                    onHover={() => setActive(i)}
                    onChoose={(newTab) => void activate(row, newTab)}
                  />
                );
              })}
            </div>
          ))}
          {emptyText && !loading && <p className="px-3 py-6 text-center text-sm text-ink-2">{emptyText}</p>}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-3">
          <span>↑↓ move</span>
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft size={11} aria-hidden /> choose
          </span>
          <span>Ctrl Enter new tab</span>
          {!level && <span>Tab switch</span>}
          <span className="ml-auto">Esc close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResultRow({
  row,
  id,
  index,
  selected,
  onHover,
  onChoose,
}: {
  row: Row;
  id: string;
  index: number;
  selected: boolean;
  onHover: () => void;
  onChoose: (newTab: boolean) => void;
}) {
  let title = '';
  let detail = '';
  let more = false;
  let muted = false;
  if (row.kind === 'command') {
    title = row.command.title;
    detail = row.command.description ?? '';
    more = Boolean(row.command.children);
  } else if (row.kind === 'node') {
    title = row.entry.description.displayName;
    detail = row.entry.description.description;
  } else if (row.kind === 'workflow') {
    title = row.workflow.name;
    detail = row.workflow.tags.map((t) => t.name).join(', ');
  } else {
    title = row.label;
    muted = true;
  }
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the input (aria-activedescendant)
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-row={index}
      onMouseMove={onHover}
      onClick={(event) => onChoose(event.ctrlKey || event.metaKey)}
      onKeyDown={undefined}
      className={cx(
        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm',
        selected ? 'bg-surface-3' : '',
        muted ? 'text-brand' : 'text-ink',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">{detail}</span>}
      {more && <ChevronRight size={14} className="shrink-0 text-ink-3" aria-hidden />}
    </div>
  );
}

export function CommandBar() {
  const open = useUiStore((s) => s.commandBarOpen);
  useShellCommands();
  useCommandBarHotkey();
  return open ? <CommandBarPanel /> : null;
}
