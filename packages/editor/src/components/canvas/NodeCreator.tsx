/** Side panel for adding nodes: search, categories, triggers first, operation actions. */
import type { ConnectionType, NodeParameters, NodeTypeDescription } from '@workflow/workflow';
import { ChevronLeft, ChevronRight, Search, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCatalog, type CatalogEntry, filterCatalog } from '../../lib/node-catalog';
import { restrictedToast, useRestrictedTypes } from '../../lib/policy-violations';
import { AI_PORT_LABELS, isTriggerDescription } from '../../lib/ports';
import { toast } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { NodeIcon } from '../NodeIcon';
import { ContactAdminDialog } from '../policies/ContactAdminDialog';
import { RestrictedNodePopover } from '../policies/RestrictedNodePopover';
import { cx } from '../ui/cx';
import { EmptyState } from '../ui/misc';

export interface NodeCreatorProps {
  nodeTypes: NodeTypeDescription[];
  onPick: (description: NodeTypeDescription, parameters?: NodeParameters) => void;
  onClose: () => void;
  needsMainInput?: boolean;
  outputType?: ConnectionType;
  noTriggerYet?: boolean;
  /** P3-11: replace this node (title "Replace <name>"; L2 filters triggers / non-triggers) */
  replaceFor?: string;
}

export function NodeCreator({
  nodeTypes,
  onPick,
  onClose,
  needsMainInput,
  outputType,
  noTriggerYet,
  replaceFor,
}: NodeCreatorProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<CatalogEntry | null>(null);
  const [active, setActive] = useState(0);
  const [contact, setContact] = useState<CatalogEntry | null>(null);
  const { restricted } = useRestrictedTypes();
  const inputRef = useRef<HTMLInputElement>(null);
  // replace mode (P3-11): a trigger is replaced by triggers only, any other node by non-triggers
  const replacedType = useWorkflowStore((s) =>
    replaceFor ? s.nodes.find((n) => n.name === replaceFor)?.type : undefined,
  );
  const replaceTriggers = replacedType
    ? isTriggerDescription(nodeTypes.find((d) => d.name === replacedType))
    : undefined;
  const catalog = useMemo(() => {
    const all = buildCatalog(nodeTypes);
    return replaceFor && replaceTriggers !== undefined
      ? all.filter((e) => e.isTrigger === replaceTriggers)
      : all;
  }, [nodeTypes, replaceFor, replaceTriggers]);
  const sections = useMemo(
    () => filterCatalog(catalog, { query, needsMainInput, outputType, noTriggerYet, restricted }),
    [catalog, query, needsMainInput, outputType, noTriggerYet, restricted],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const choose = (entry: CatalogEntry) => {
    // P6-50: a blocked type is listed but never added
    if (restricted.has(entry.description.name)) {
      const text = restrictedToast(entry.description.displayName);
      toast.error(text.title, text.description);
      return;
    }
    if (entry.actions.length > 1) {
      setExpanded(entry);
      return;
    }
    onPick(entry.description, entry.actions[0]?.parameters);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (expanded) setExpanded(null);
      else onClose();
      return;
    }
    if (expanded) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'Enter' && flat[active]) {
      event.preventDefault();
      choose(flat[active]);
    }
  };

  const title = replaceFor
    ? `Replace ${replaceFor}`
    : outputType
      ? `Add ${AI_PORT_LABELS[outputType]?.toLowerCase() ?? 'sub-node'}`
      : needsMainInput
        ? 'What happens next?'
        : noTriggerYet
          ? 'What starts this workflow?'
          : 'Add a node';

  let index = -1;
  return (
    <aside
      className="flex h-full w-[360px] flex-col border-l border-line bg-surface shadow-lift"
      aria-label="Node creator"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(null)}
            className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3"
            aria-label="Back to all nodes"
          >
            <ChevronLeft size={16} />
          </button>
        ) : null}
        <h2 className="flex-1 truncate text-md font-semibold">
          {expanded ? expanded.description.displayName : title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3"
          aria-label="Close node creator"
        >
          <X size={16} />
        </button>
      </div>
      {!expanded && (
        <div className="relative px-4 pb-3">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-7 -translate-y-[calc(50%+6px)] text-ink-3"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            className="wf-field pl-9"
            placeholder="Search nodes, apps and actions"
            aria-label="Search nodes"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
      )}
      <div className="wf-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {expanded ? (
          <div className="flex flex-col">
            <p className="px-2 pb-2 text-sm text-ink-2">{expanded.description.description}</p>
            {expanded.actions.map((action) => (
              <button
                key={`${String(action.parameters.resource ?? '')}:${String(action.parameters.operation)}`}
                type="button"
                className="flex items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3"
                onClick={() => onPick(expanded.description, action.parameters)}
              >
                <span className="mt-0.5 grid size-7 place-items-center rounded-md bg-surface-3 text-ink-2">
                  <NodeIcon description={expanded.description} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{action.label}</span>
                  {action.description && (
                    <span className="block truncate text-xs text-ink-3">{action.description}</span>
                  )}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="mt-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-brand hover:bg-surface-3"
              onClick={() => onPick(expanded.description)}
            >
              Add without choosing an action
            </button>
          </div>
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title="Nothing matches"
            description="Try a different word, an app name or an action."
          />
        ) : (
          sections.map((section) => (
            <section key={section.title} className="mb-3">
              <h3 className="flex items-center gap-1.5 px-2 pt-2 pb-1 font-sans text-xs font-semibold text-ink-3">
                {section.title === 'Start with a trigger' && <Zap size={12} className="text-brand" />}
                {section.title}
              </h3>
              <ul>
                {section.entries.map((entry) => {
                  index += 1;
                  const isActive = index === active;
                  const lock = restricted.get(entry.description.name);
                  return (
                    <li key={entry.description.name} className={lock ? 'flex items-center' : undefined}>
                      <button
                        type="button"
                        className={cx(
                          'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left',
                          isActive ? 'bg-brand-soft' : 'hover:bg-surface-3',
                          lock && 'min-w-0 flex-1 opacity-50',
                        )}
                        aria-disabled={lock ? true : undefined}
                        onClick={() => choose(entry)}
                        data-testid={`creator-item-${entry.description.name}`}
                      >
                        <span
                          className="grid size-9 shrink-0 place-items-center rounded-lg"
                          style={{
                            color:
                              entry.description.iconColor ??
                              entry.description.defaults.color ??
                              'var(--wf-ink-2)',
                            background: 'var(--wf-surface-3)',
                          }}
                        >
                          <NodeIcon description={entry.description} size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                            {entry.description.displayName}
                            {entry.isTrigger && <Zap size={11} className="text-brand" aria-label="Trigger" />}
                          </span>
                          <span className="block truncate text-xs text-ink-3">
                            {entry.description.description}
                          </span>
                        </span>
                        {!lock && entry.actions.length > 1 && (
                          <ChevronRight size={14} className="text-ink-3" aria-hidden="true" />
                        )}
                      </button>
                      {lock && (
                        <RestrictedNodePopover
                          entry={lock}
                          displayName={entry.description.displayName}
                          onContactAdmin={() => setContact(entry)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      <ContactAdminDialog
        open={contact !== null}
        onClose={() => setContact(null)}
        type={contact?.description.name ?? ''}
        displayName={contact?.description.displayName}
      />
    </aside>
  );
}
