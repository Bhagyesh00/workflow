/** Bottom drawer: console output of Code nodes and a timeline of node runs. */
import type { RunData } from '@workflow/workflow';
import { ChevronDown, Eraser, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '../../lib/format';
import type { LogEntry } from '../../stores/run-store';
import { IconButton } from '../ui/Button';
import { cx } from '../ui/cx';
import { EmptyState } from '../ui/misc';
import { Tabs } from '../ui/Tabs';

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

export interface TimelineEntry {
  node: string;
  run: number;
  start: number;
  duration: number;
  status: string;
}

export function buildTimeline(runData: RunData): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    runs.forEach((task, run) => {
      entries.push({
        node,
        run,
        start: task.startTime,
        duration: task.executionTime ?? 0,
        status: task.error ? 'error' : task.executionStatus,
      });
    });
  }
  return entries.sort((a, b) => a.start - b.start);
}

export function LogPanel({
  logs,
  runData,
  onClear,
  onClose,
  onFocusNode,
}: {
  logs: LogEntry[];
  runData: RunData;
  onClear: () => void;
  onClose: () => void;
  onFocusNode: (name: string) => void;
}) {
  const [tab, setTab] = useState<'console' | 'timeline'>('console');
  const endRef = useRef<HTMLDivElement>(null);
  const timeline = useMemo(() => buildTimeline(runData), [runData]);
  const t0 = timeline[0]?.start ?? 0;
  const total = Math.max(1, ...timeline.map((e) => e.start + e.duration - t0));

  useEffect(() => {
    if (tab === 'console' && logs.length) endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [logs.length, tab]);

  return (
    <section className="flex h-64 flex-col border-t border-line bg-surface" aria-label="Logs">
      <div className="flex items-center gap-3 px-4 pt-2">
        <Terminal size={15} className="text-ink-3" />
        <Tabs
          size="sm"
          label="Log views"
          value={tab}
          onChange={setTab}
          items={[
            {
              value: 'console',
              label: 'Console',
              badge: logs.length ? <span className="text-ink-3">{logs.length}</span> : undefined,
            },
            { value: 'timeline', label: 'Run timeline' },
          ]}
        />
        <span className="ml-auto flex items-center gap-1 pb-1">
          {tab === 'console' && (
            <IconButton label="Clear console" size="sm" onClick={onClear}>
              <Eraser size={14} />
            </IconButton>
          )}
          <IconButton label="Close logs" size="sm" onClick={onClose}>
            <ChevronDown size={15} />
          </IconButton>
        </span>
      </div>
      <div className="wf-scroll min-h-0 flex-1 overflow-auto border-t border-line">
        {tab === 'console' ? (
          logs.length === 0 ? (
            <EmptyState
              title="Nothing logged yet"
              description="console.log() calls in Code nodes show up here during manual runs."
              className="py-8"
            />
          ) : (
            <ol className="font-mono text-xs">
              {logs.map((entry) => (
                <li key={entry.id} className="flex gap-3 border-b border-line px-4 py-1.5">
                  <span className="shrink-0 text-ink-3">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFocusNode(entry.nodeName)}
                    className="shrink-0 font-sans font-semibold text-brand hover:underline"
                  >
                    {entry.nodeName}
                  </button>
                  <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-ink">
                    {entry.args.map(formatArg).join(' ')}
                  </span>
                </li>
              ))}
              <div ref={endRef} />
            </ol>
          )
        ) : timeline.length === 0 ? (
          <EmptyState
            title="No run yet"
            description="Execute the workflow to see how long each step took."
            className="py-8"
          />
        ) : (
          <ol className="px-4 py-2">
            {timeline.map((e) => (
              <li
                key={`${e.node}-${e.run}`}
                className="grid grid-cols-[180px_1fr_70px] items-center gap-3 py-1 text-xs"
              >
                <button
                  type="button"
                  onClick={() => onFocusNode(e.node)}
                  className="truncate text-left font-semibold text-ink hover:text-brand"
                >
                  {e.node}
                  {e.run > 0 && <span className="text-ink-3"> (run {e.run + 1})</span>}
                </button>
                <div className="relative h-2.5 rounded-full bg-surface-3">
                  <span
                    className={cx(
                      'absolute top-0 h-full min-w-1 rounded-full',
                      e.status === 'error' ? 'bg-err' : 'bg-ok',
                    )}
                    style={{
                      left: `${((e.start - t0) / total) * 100}%`,
                      width: `${Math.max(0.6, (e.duration / total) * 100)}%`,
                    }}
                  />
                </div>
                <span className="text-right text-ink-2">{formatDuration(e.duration)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
