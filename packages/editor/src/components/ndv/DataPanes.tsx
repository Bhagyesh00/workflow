/** Input and output panes of the node details view. */
import type {
  DirtyReason,
  ExecutionErrorShape,
  Item,
  NodeTypeDescription,
  RunData,
  WorkflowNode,
} from '@workflow/workflow';
import {
  Braces,
  Copy,
  GitCompareArrows,
  Pencil,
  Pin,
  PinOff,
  Play,
  Sparkles,
  Table2,
  Workflow,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAiBuilderFeature, useMe } from '../../api/queries';
import { openBuilderForError } from '../../features/builder/error-entry';
import { useCanEditWorkflow } from '../../features/editor/open-resources';
import { compareItems } from '../../lib/data';
import { getNodeOutput } from '../../lib/expression-context';
import { formatDuration, plural } from '../../lib/format';
import type { NodePorts } from '../../lib/ports';
import { getAncestors, getMainParents, type WorkflowGraph } from '../../lib/workflow-ops';
import { useWorkflowStore } from '../../stores/workflow-store';
import { CodeEditor } from '../code/CodeEditor';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Select } from '../ui/Field';
import { Callout, EmptyState } from '../ui/misc';
import { Segmented, Tabs } from '../ui/Tabs';
import { type DataViewMode, RunDataView } from './RunDataView';

function ViewModeSwitch({ value, onChange }: { value: DataViewMode; onChange: (v: DataViewMode) => void }) {
  return (
    <Segmented
      label="Data view"
      value={value}
      onChange={onChange}
      items={[
        { value: 'schema', label: <Workflow size={12} />, title: 'Schema' },
        { value: 'table', label: <Table2 size={12} />, title: 'Table' },
        { value: 'json', label: <Braces size={12} />, title: 'JSON' },
      ]}
    />
  );
}

function RunSelect({
  runs,
  value,
  onChange,
}: {
  runs: number;
  value: number;
  onChange: (v: number) => void;
}) {
  if (runs <= 1) return null;
  return (
    <Select
      aria-label="Run"
      className="w-28"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {Array.from({ length: runs }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
        <option key={i} value={i}>
          Run {i + 1}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

export function InputPane({
  graph,
  node,
  runData,
  onExecuteParent,
  readOnly,
}: {
  graph: WorkflowGraph;
  node: WorkflowNode;
  runData: RunData;
  onExecuteParent?: (parent: string) => void;
  readOnly: boolean;
}) {
  const directParents = useMemo(
    () => getMainParents(graph.connections, node.name),
    [graph.connections, node.name],
  );
  const ancestors = useMemo(() => getAncestors(graph.connections, node.name), [graph.connections, node.name]);
  const defaultParent =
    directParents.find((p) => runData[p.node]?.length)?.node ?? directParents[0]?.node ?? ancestors[0];
  const [parent, setParent] = useState<string | undefined>(defaultParent);
  const [runIndex, setRunIndex] = useState(0);
  const [mode, setMode] = useState<DataViewMode>('schema');

  useEffect(() => {
    if (!parent || !ancestors.includes(parent)) setParent(defaultParent);
  }, [ancestors, parent, defaultParent]);

  const runs = parent ? (runData[parent]?.length ?? 0) : 0;
  useEffect(() => setRunIndex(Math.max(0, runs - 1)), [runs]);

  const direct = directParents.find((p) => p.node === parent);
  const items = parent ? (getNodeOutput(runData, parent, direct?.outputIndex ?? 0, runIndex) ?? []) : [];

  if (!ancestors.length) {
    return (
      <EmptyState
        icon={<Workflow size={20} />}
        title="No input connected"
        description="Connect a node in front of this one to see the data it receives."
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Select
          aria-label="Input from node"
          className="min-w-0 flex-1"
          value={parent ?? ''}
          onChange={(e) => setParent(e.target.value)}
        >
          {ancestors.map((name) => (
            <option key={name} value={name}>
              {name}
              {runData[name]?.length ? '' : ' (no data yet)'}
            </option>
          ))}
        </Select>
        <RunSelect runs={runs} value={runIndex} onChange={setRunIndex} />
        <ViewModeSwitch value={mode} onChange={setMode} />
      </div>
      {items.length > 0 && <p className="px-3 pb-1 text-xs text-ink-3">{plural(items.length, 'item')}</p>}
      <div className="min-h-0 flex-1 border-t border-line">
        <RunDataView
          items={items}
          mode={mode}
          source={readOnly ? undefined : { fromNode: direct ? undefined : parent }}
          empty={
            <EmptyState
              title={parent && runs ? 'No items came through' : 'No input data yet'}
              description={
                parent && runs ? undefined : 'Execute the previous nodes to see their output here.'
              }
              action={
                onExecuteParent && parent && !runs ? (
                  <Button size="sm" icon={<Play size={13} />} onClick={() => onExecuteParent(parent)}>
                    Execute previous nodes
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** Structured, actionable errors (NF-15): code, hint, item, parameter and the failing HTTP call. */
export function ErrorPanel({ error }: { error: ExecutionErrorShape }) {
  const [showStack, setShowStack] = useState(false);
  const aiBuilder = useAiBuilderFeature();
  const me = useMe().data;
  const canEdit = useCanEditWorkflow();
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const fixTarget = error.node; // the engine and the demo run set it on every node error
  // P5-65: editors and above, when the builder is on
  const canFixWithAi = aiBuilder.enabled && me !== undefined && canEdit && !readOnly && !!fixTarget;
  const facts: Array<[string, string]> = [];
  if (error.itemIndex !== undefined) facts.push(['Item', String(error.itemIndex + 1)]);
  if (error.parameter) facts.push(['Parameter', error.parameter]);
  if (error.request) facts.push(['Request', `${error.request.method} ${error.request.url}`]);
  const status = error.response?.statusCode ?? error.httpCode;
  if (status !== undefined) facts.push(['Status', String(status)]);
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="node-error">
      <Callout tone="err" title={error.message}>
        {error.description && <p className="mt-1">{error.description}</p>}
        {error.code && <p className="mt-1 font-mono text-xs">{error.code}</p>}
      </Callout>
      {error.hint && (
        <Callout tone="info" title="How to fix it">
          {error.hint}
        </Callout>
      )}
      {canFixWithAi && fixTarget && (
        <div>
          <Button size="sm" onClick={() => void openBuilderForError(fixTarget, error.message)}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Fix with AI
          </Button>
        </div>
      )}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-3">{label}</dt>
              <dd className="font-mono break-all text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {error.response?.body && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-ink-2">Response body</summary>
          <pre className="wf-scroll mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 whitespace-pre-wrap text-ink-2">
            {error.response.body}
          </pre>
        </details>
      )}
      {error.stack && (
        <div>
          <button
            type="button"
            className="text-xs font-semibold text-ink-2 hover:text-ink"
            onClick={() => setShowStack((s) => !s)}
          >
            {showStack ? 'Hide details' : 'Show details'}
          </button>
          {showStack && (
            <pre className="wf-scroll mt-1 max-h-60 overflow-auto rounded-lg bg-surface-2 p-2 text-2xs whitespace-pre-wrap text-ink-2">
              {error.stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function itemsToEditable(items: Item[]): string {
  return JSON.stringify(
    items.map((i) => i.json),
    null,
    2,
  );
}

export function parsePinnedJson(text: string): { items: Item[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `Invalid JSON: ${(e as Error).message}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return { error: 'Use an object or a list of objects, one per item.' };
  }
  return { items: list.map((json) => ({ json: json as Record<string, unknown> })) };
}

function PinEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (items: Item[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const result = useMemo(() => parsePinnedJson(text), [text]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p className="text-xs text-ink-2">Edit the output as JSON. Each object becomes one item.</p>
      <div className="wf-field min-h-0 flex-1 overflow-hidden !p-0">
        <CodeEditor
          language="json"
          value={text}
          onChange={setText}
          minRows={10}
          lineNumbers
          ariaLabel="Pinned data"
          className="h-full"
        />
      </div>
      {'error' in result && <p className="text-xs text-err">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={'error' in result}
          onClick={() => 'items' in result && onSave(result.items)}
        >
          Save and pin
        </Button>
      </div>
    </div>
  );
}

function SubNodeLogs({ node, runData, ports }: { node: WorkflowNode; runData: RunData; ports: NodePorts }) {
  const runs = runData[node.name] ?? [];
  const [selected, setSelected] = useState(runs.length - 1);
  useEffect(() => setSelected(runs.length - 1), [runs.length]);
  const type = ports.outputs[0]?.type;
  if (!runs.length) {
    return (
      <EmptyState
        title="No calls yet"
        description="Sub-nodes run when their root node uses them. Execute the root node to see each call here."
      />
    );
  }
  const task = runs[Math.max(0, selected)];
  const input = type ? task.inputOverride?.[type]?.[0]?.[0]?.json : undefined;
  const output = type ? task.data?.[type]?.[0]?.[0]?.json : undefined;
  return (
    <div className="flex h-full min-h-0">
      <ol className="wf-scroll w-36 shrink-0 overflow-auto border-r border-line p-1.5" aria-label="Calls">
        {runs.map((run, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <li key={i}>
            <button
              type="button"
              onClick={() => setSelected(i)}
              className={cx(
                'flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs',
                i === selected ? 'bg-brand-soft font-semibold text-brand' : 'text-ink-2 hover:bg-surface-3',
              )}
            >
              Call {i + 1}
              {run.error && (
                <span className="size-1.5 rounded-full bg-err">
                  <span className="sr-only">failed</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      <div className="wf-scroll min-w-0 flex-1 overflow-auto p-3 text-xs">
        {task.error && <ErrorPanel error={task.error} />}
        <h4 className="mb-1 font-sans text-xs font-semibold text-ink-2">Input</h4>
        <pre className="mb-3 rounded-lg bg-surface-2 p-2 font-mono break-words whitespace-pre-wrap">
          {JSON.stringify(input ?? null, null, 2)}
        </pre>
        <h4 className="mb-1 font-sans text-xs font-semibold text-ink-2">Output</h4>
        <pre className="rounded-lg bg-surface-2 p-2 font-mono break-words whitespace-pre-wrap">
          {JSON.stringify(output ?? null, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function Comparison({ before, after }: { before: Item[]; after: Item[] }) {
  const result = useMemo(() => compareItems(before, after), [before, after]);
  if (result.identical) {
    return (
      <p className="p-3 text-sm text-ink-2">
        Same output as the previous run ({plural(after.length, 'item')}).
      </p>
    );
  }
  return (
    <div className="wf-scroll h-full overflow-auto p-3">
      <p className="mb-2 text-xs text-ink-2">
        Previous run: {plural(result.beforeCount, 'item')}. This run: {plural(result.afterCount, 'item')}.
      </p>
      <ul className="flex flex-col gap-1 font-mono text-xs" aria-label="Changes since the previous run">
        {result.entries.map((entry) => (
          <li
            key={`${entry.kind}:${entry.path}`}
            className={cx(
              'rounded-md border-l-2 px-2 py-1',
              entry.kind === 'added' && 'border-ok bg-ok-soft',
              entry.kind === 'removed' && 'border-err bg-err-soft',
              entry.kind === 'changed' && 'border-warn bg-warn-soft',
            )}
          >
            <span className="font-semibold">{entry.path}</span>{' '}
            {entry.kind === 'added' && <span>added {JSON.stringify(entry.after)}</span>}
            {entry.kind === 'removed' && <span>removed (was {JSON.stringify(entry.before)})</span>}
            {entry.kind === 'changed' && (
              <span>
                {JSON.stringify(entry.before)} <span className="text-ink-3">became</span>{' '}
                {JSON.stringify(entry.after)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OutputPane({
  node,
  description,
  ports,
  runData,
  previousRunData,
  pinned,
  readOnly,
  running,
  onPin,
  onExecute,
  dirty,
}: {
  node: WorkflowNode;
  description?: NodeTypeDescription;
  ports: NodePorts;
  runData: RunData;
  previousRunData: RunData | null;
  pinned?: Item[];
  readOnly: boolean;
  running: boolean;
  onPin: (items: Item[] | null) => void;
  onExecute?: () => void;
  /** P3-06 (L6): why this node's output is stale; the banner shows for own-parameter changes */
  dirty?: DirtyReason;
}) {
  const runs = runData[node.name] ?? [];
  const [runIndex, setRunIndex] = useState(Math.max(0, runs.length - 1));
  const [output, setOutput] = useState(0);
  const [mode, setMode] = useState<DataViewMode>('table');
  const [editing, setEditing] = useState(false);
  const [compare, setCompare] = useState(false);
  useEffect(() => setRunIndex(Math.max(0, runs.length - 1)), [runs.length]);

  if (ports.isSubNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-sm font-semibold">Calls from the root node</span>
        </div>
        <div className="min-h-0 flex-1 border-t border-line">
          <SubNodeLogs node={node} runData={runData} ports={ports} />
        </div>
      </div>
    );
  }

  const mainOutputs = ports.outputs.filter((p) => p.type === 'main');
  const task = runs[runIndex];
  const items: Item[] = pinned ?? getNodeOutput(runData, node.name, output, runIndex) ?? [];
  const previous = previousRunData ? getNodeOutput(previousRunData, node.name, output) : null;
  const executionTime = task?.executionTime;

  if (editing) {
    return (
      <PinEditor
        initial={itemsToEditable(pinned ?? items)}
        onCancel={() => setEditing(false)}
        onSave={(next) => {
          onPin(next);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {mainOutputs.length > 1 && !pinned ? (
          <Tabs
            size="sm"
            label="Outputs"
            value={String(output)}
            onChange={(v) => setOutput(Number(v))}
            items={mainOutputs.map((p, i) => ({
              value: String(i),
              label: p.label ?? `Output ${i + 1}`,
              badge: (
                <span className={cx('text-2xs', p.category === 'error' ? 'text-err' : 'text-ink-3')}>
                  {getNodeOutput(runData, node.name, i, runIndex)?.length ?? 0}
                </span>
              ),
            }))}
          />
        ) : (
          <span className="text-sm font-semibold">{pinned ? 'Pinned output' : 'Output'}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <RunSelect runs={pinned ? 0 : runs.length} value={runIndex} onChange={setRunIndex} />
          <ViewModeSwitch value={mode} onChange={setMode} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-ink-3">
        {items.length > 0 && <span>{plural(items.length, 'item')}</span>}
        {executionTime !== undefined && !pinned && <span>took {formatDuration(executionTime)}</span>}
        <span className="ml-auto flex items-center gap-1">
          {!readOnly && previous && !pinned && items.length > 0 && (
            <Button
              size="sm"
              variant={compare ? 'subtle' : 'ghost'}
              icon={<GitCompareArrows size={13} />}
              onClick={() => setCompare((c) => !c)}
              aria-pressed={compare}
            >
              Compare with previous run
            </Button>
          )}
          {!readOnly && pinned && (
            <>
              <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" icon={<PinOff size={13} />} onClick={() => onPin(null)}>
                Unpin
              </Button>
            </>
          )}
          {!readOnly && !pinned && items.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pin size={13} />}
              onClick={() =>
                onPin(items.map((i) => (i.binary ? { json: i.json, binary: i.binary } : { json: i.json })))
              }
              title="Use this output instead of running the node in manual runs"
            >
              Pin
            </Button>
          )}
          {items.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy size={13} />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(
                    JSON.stringify(
                      items.map((i) => i.json),
                      null,
                      2,
                    ),
                  )
                  .catch(() => undefined)
              }
            >
              Copy
            </Button>
          )}
        </span>
      </div>
      {pinned && (
        <Callout tone="info" className="mx-3 mb-2 py-1.5 text-xs">
          Pinned data replaces this node’s output in manual runs.
        </Callout>
      )}
      {dirty === 'parameters' && (
        <Callout tone="warn" className="mx-3 mb-2 py-1.5 text-xs">
          {pinned
            ? 'Node parameter changes will not affect pinned output data.'
            : 'Node parameters have changed. Execute the step again to refresh the output.'}
        </Callout>
      )}
      {!pinned && task?.hints && task.hints.length > 0 && (
        <ul aria-label="Execution hints" className="mx-3 mb-2 flex list-none flex-col gap-1.5 p-0">
          {task.hints.map((hint, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: hints are positional and may repeat a message
            <li key={`${i}-${hint.message}`}>
              <Callout tone={hint.level === 'warning' ? 'warn' : 'info'} className="py-1.5 text-xs">
                {hint.message}
              </Callout>
            </li>
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1 border-t border-line">
        {task?.error && !pinned ? (
          <ErrorPanel error={task.error} />
        ) : compare && previous ? (
          <Comparison before={previous} after={items} />
        ) : (
          <RunDataView
            items={items}
            mode={mode}
            empty={
              <EmptyState
                title={runs.length ? 'No output items' : running ? 'Running…' : 'No output yet'}
                description={
                  runs.length
                    ? 'The node ran but returned nothing on this output.'
                    : `Execute this step to see what ${description?.displayName ?? 'the node'} returns, or set mock data.`
                }
                action={
                  !readOnly && !runs.length ? (
                    <div className="flex gap-2">
                      {onExecute && (
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Play size={13} />}
                          onClick={onExecute}
                          loading={running}
                        >
                          Execute step
                        </Button>
                      )}
                      <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
                        Set mock data
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            }
          />
        )}
      </div>
    </div>
  );
}
