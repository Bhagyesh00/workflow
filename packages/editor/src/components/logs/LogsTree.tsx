/**
 * The tree of node runs (P5-60): status icon, name, duration and tokens per row, expand and collapse,
 * and the arrow keys (`role="tree"`). A click or Enter selects the run and focuses its node on the canvas.
 */
import type { ExecutionStatus } from '@workflow/workflow';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock,
  Square,
  XCircle,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { formatDuration } from '../../lib/format';
import { formatTokens, type LogNode, type LogRow } from '../../lib/logs-tree';
import { cx } from '../ui/cx';
import { Spinner, statusLabel } from '../ui/misc';

export function StatusIcon({ status }: { status: ExecutionStatus }) {
  const label = statusLabel(status);
  switch (status) {
    case 'success':
      return <CheckCircle2 size={13} className="shrink-0 text-ok" aria-label={label} role="img" />;
    case 'error':
      return <XCircle size={13} className="shrink-0 text-err" aria-label={label} role="img" />;
    case 'crashed':
      return <AlertTriangle size={13} className="shrink-0 text-err" aria-label={label} role="img" />;
    case 'running':
      return (
        <span role="img" aria-label={label} className="text-brand">
          <Spinner size={13} />
        </span>
      );
    case 'waiting':
      return <Clock size={13} className="shrink-0 text-warn" aria-label={label} role="img" />;
    case 'canceled':
      return <Square size={12} className="shrink-0 text-ink-3" aria-label={label} role="img" />;
    default:
      return <CircleDashed size={13} className="shrink-0 text-ink-3" aria-label={label} role="img" />;
  }
}

const typeLabels: Record<string, string> = {
  ai_languageModel: 'Model',
  ai_tool: 'Tool',
  ai_memory: 'Memory',
  ai_outputParser: 'Parser',
  ai_embedding: 'Embedding',
  ai_vectorStore: 'Store',
  ai_document: 'Document',
  ai_textSplitter: 'Splitter',
  ai_retriever: 'Retriever',
  ai_reranker: 'Reranker',
};

export function LogsTree({
  rows,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  onFocusNode,
}: {
  rows: LogRow[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (node: LogNode) => void;
  onFocusNode: (name: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef<string | null>(null);
  const tabId = rows.some((r) => r.node.id === selectedId) ? selectedId : (rows[0]?.node.id ?? null);

  // after an arrow key selects another row, its element takes the focus
  useEffect(() => {
    if (!moveFocus.current) return;
    const id = moveFocus.current;
    moveFocus.current = null;
    for (const el of Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])) {
      if (el.dataset.runId === id) el.focus();
    }
  });

  const go = (row: LogRow | undefined) => {
    if (!row) return;
    moveFocus.current = row.node.id;
    onSelect(row.node);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const row = rows[index];
    if (!row || event.target !== event.currentTarget) return;
    const open = row.node.children.length > 0 && !collapsed.has(row.node.id);
    switch (event.key) {
      case 'ArrowDown':
        go(rows[index + 1]);
        break;
      case 'ArrowUp':
        go(rows[index - 1]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows[rows.length - 1]);
        break;
      case 'ArrowRight':
        if (row.node.children.length && !open) onToggle(row.node.id);
        else if (open) go(rows[index + 1]);
        break;
      case 'ArrowLeft':
        if (open) onToggle(row.node.id);
        else if (row.parent) go(rows.find((r) => r.node === row.parent));
        break;
      case 'Enter':
      case ' ':
        onSelect(row.node);
        onFocusNode(row.node.node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div ref={listRef} role="tree" aria-label="Node runs" className="py-1 text-xs">
      {rows.map(({ node, depth }, index) => {
        const expandable = node.children.length > 0;
        const isOpen = expandable && !collapsed.has(node.id);
        const selected = node.id === selectedId;
        return (
          <div
            key={node.id}
            role="treeitem"
            tabIndex={node.id === tabId ? 0 : -1}
            aria-level={depth + 1}
            aria-selected={selected}
            aria-expanded={expandable ? isOpen : undefined}
            data-run-id={node.id}
            onClick={() => {
              onSelect(node);
              onFocusNode(node.node);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              'flex cursor-pointer items-center gap-1.5 py-1 pr-3 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand',
              selected && 'bg-brand-soft',
            )}
            style={{ paddingLeft: 8 + depth * 16 }}
          >
            {expandable ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={isOpen ? `Collapse ${node.node}` : `Expand ${node.node}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(node.id);
                }}
                className="grid size-4 shrink-0 place-items-center text-ink-3 hover:text-ink"
              >
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            ) : (
              <span className="size-4 shrink-0" aria-hidden="true" />
            )}
            <StatusIcon status={node.status} />
            <span className="min-w-0 truncate font-semibold text-ink">
              {node.node}
              {node.runIndex > 0 && (
                <span className="font-normal text-ink-3"> (run {node.runIndex + 1})</span>
              )}
            </span>
            {node.type !== 'main' && (
              <span className="shrink-0 rounded bg-surface-3 px-1 text-2xs text-ink-2">
                {typeLabels[node.type] ?? node.type}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 text-ink-3">
              {node.tokens && <span>{formatTokens(node.tokens)}</span>}
              {node.duration > 0 && <span>{formatDuration(node.duration)}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
