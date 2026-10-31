/**
 * Resource locator: pick a resource from a searchable list (kind `listSearch`, paginated), or
 * enter its id or URL. Value shape: `{ __rl: true, mode, value, cachedResultName?, cachedResultUrl? }`.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  isResourceLocatorValue,
  type ResourceLocatorMode,
  type ResourceLocatorValue,
  resolveNodeParameters,
} from '@workflow/workflow';
import { ChevronDown, ExternalLink, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { nodeTypesApi } from '../../api/endpoints';
import { useWorkflowStore } from '../../stores/workflow-store';
import { cx } from '../ui/cx';
import { Select } from '../ui/Field';
import { Spinner } from '../ui/misc';
import { isExpressionValue, useParameterContext } from './context';
import { ExpressionInput } from './ExpressionInput';
import type { InputProps } from './inputs';

function normalize(value: unknown, modes: ResourceLocatorMode[]): ResourceLocatorValue {
  if (isResourceLocatorValue(value)) return value;
  return { __rl: true, mode: modes[0]?.name ?? 'id', value: typeof value === 'string' ? value : '' };
}

export function extractFromUrl(mode: ResourceLocatorMode | undefined, url: string): string | null {
  if (!mode?.extractValue || !url) return null;
  try {
    const match = new RegExp(mode.extractValue.regex).exec(url);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function ListMode({
  mode,
  value,
  onChange,
  id,
}: {
  mode: ResourceLocatorMode;
  value: ResourceLocatorValue;
  onChange: (value: ResourceLocatorValue) => void;
  id: string;
}) {
  const ctx = useParameterContext();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const rootRef = useRef<HTMLDivElement>(null);
  const method = mode.typeOptions?.searchListMethod;

  const workflowId = useWorkflowStore((s) => s.meta.id);
  const query = useInfiniteQuery({
    queryKey: [
      'list-search',
      workflowId,
      ctx.node.type,
      method,
      ctx.node.name,
      deferredFilter,
      JSON.stringify(ctx.node.credentials ?? {}),
    ],
    enabled: open && Boolean(method),
    initialPageParam: undefined as string | undefined,
    retry: false,
    queryFn: ({ pageParam }) =>
      nodeTypesApi.listSearch({
        nodeType: ctx.node.type,
        method: method!,
        kind: 'listSearch',
        node: {
          ...ctx.node,
          parameters: ctx.description
            ? resolveNodeParameters(ctx.description.properties, ctx.node.parameters, {
                nodeVersion: ctx.node.typeVersion,
              })
            : ctx.node.parameters,
        },
        filter: deferredFilter || undefined,
        paginationToken: pageParam,
        workflowId,
      }),
    getNextPageParam: (last) => last?.paginationToken || undefined,
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const results = query.data?.pages.flatMap((p) => p?.results ?? []) ?? [];
  return (
    <div ref={rootRef} className="relative flex-1">
      <button
        id={id}
        type="button"
        disabled={ctx.readOnly}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="wf-field flex items-center gap-2 text-left"
      >
        <span className={cx('min-w-0 flex-1 truncate', !value.value && 'text-ink-3')}>
          {value.cachedResultName || value.value || `Choose from the list…`}
        </span>
        {value.cachedResultUrl && /^https?:\/\//.test(value.cachedResultUrl) && (
          <a
            href={value.cachedResultUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in new tab"
            onClick={(e) => e.stopPropagation()}
            className="text-ink-3 hover:text-brand"
          >
            <ExternalLink size={13} />
          </a>
        )}
        <ChevronDown size={14} className="text-ink-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-xl border border-line bg-surface p-1.5 shadow-lift">
          <div className="relative mb-1">
            <Search
              size={13}
              className="absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
            />
            <input
              className="wf-field pl-8"
              placeholder="Search…"
              aria-label="Search resources"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div role="listbox" className="wf-scroll max-h-60 overflow-auto">
            {results.map((r) => (
              <button
                key={r.value}
                type="button"
                role="option"
                aria-selected={r.value === value.value}
                onClick={() => {
                  onChange({
                    __rl: true,
                    mode: mode.name,
                    value: r.value,
                    cachedResultName: r.name,
                    cachedResultUrl: r.url,
                  });
                  setOpen(false);
                }}
                className={cx(
                  'flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3',
                  r.value === value.value && 'bg-brand-soft text-brand',
                )}
              >
                {r.name}
              </button>
            ))}
            {query.isFetching && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-ink-2">
                <Spinner size={12} /> Loading…
              </div>
            )}
            {!query.isFetching && !results.length && !query.error && (
              <p className="px-2 py-1.5 text-sm text-ink-3">
                {method ? 'No results' : 'This list has no search method'}
              </p>
            )}
            {query.error && <p className="px-2 py-1.5 text-sm text-err">{errorMessage(query.error)}</p>}
            {query.hasNextPage && !query.isFetchingNextPage && (
              <button
                type="button"
                onClick={() => void query.fetchNextPage()}
                className="w-full rounded-lg px-2 py-1.5 text-left text-sm font-semibold text-brand hover:bg-surface-3"
              >
                Load more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ResourceLocatorInput({ prop, value, onChange, id }: InputProps) {
  const ctx = useParameterContext();
  const modes = prop.modes?.length
    ? prop.modes
    : [{ displayName: 'ID', name: 'id', type: 'string' as const }];
  const current = normalize(value, modes);
  const mode = modes.find((m) => m.name === current.mode) ?? modes[0];
  const set = (patch: Partial<ResourceLocatorValue>) => onChange({ ...current, ...patch });
  const extracted = mode.name === 'url' ? extractFromUrl(mode, current.value) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1.5">
        <Select
          aria-label={`${prop.displayName} mode`}
          className="w-32 shrink-0"
          value={mode.name}
          disabled={ctx.readOnly}
          onChange={(e) => onChange({ __rl: true, mode: e.target.value, value: '' })}
        >
          {modes.map((m) => (
            <option key={m.name} value={m.name}>
              {m.displayName}
            </option>
          ))}
        </Select>
        {isExpressionValue(current.value) && ctx.allowExpressions ? (
          <div className="min-w-0 flex-1">
            <ExpressionInput
              value={current.value}
              onChange={(v) => set({ value: v })}
              ariaLabel={prop.displayName}
            />
          </div>
        ) : mode.type === 'list' ? (
          <ListMode mode={mode} value={current} onChange={onChange} id={id} />
        ) : (
          <input
            id={id}
            className="wf-field flex-1"
            placeholder={mode.placeholder}
            value={current.value}
            readOnly={ctx.readOnly}
            onChange={(e) => {
              const next = e.target.value;
              set({
                value: ctx.allowExpressions && next.includes('{{') ? `=${next}` : next,
                cachedResultName: undefined,
              });
            }}
          />
        )}
      </div>
      {extracted && <p className="text-xs text-ink-3">Resolved id: {extracted}</p>}
      {mode.name === 'url' &&
        current.value &&
        !extracted &&
        mode.extractValue &&
        !isExpressionValue(current.value) && (
          <p className="text-xs text-err">This URL does not look like a link to this resource</p>
        )}
    </div>
  );
}
