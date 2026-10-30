/**
 * Node details view: input data | parameters & settings | output data. Opened by double-clicking
 * a node. Parameters edit the workflow store; previews use the run store's latest data.
 */
import type { NodeProperty } from '@workflow/workflow';
import { BookOpen, Copy, Play, Radio, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNodeTypes, useSettings, useVariables, useWebhookUrls } from '../../api/queries';
import { flattenSchema, inferSchema } from '../../lib/data';
import {
  buildExpressionContext,
  getNodeOutput,
  previewExpression,
  resolveInput,
  withPinnedData,
} from '../../lib/expression-context';
import { deriveNodePorts } from '../../lib/ports';
import { RenameError } from '../../lib/workflow-ops';
import { useRunStore } from '../../stores/run-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import type { CompletionData } from '../code/completions';
import { NodeCredentials } from '../credentials/NodeCredentials';
import { NodeIcon } from '../NodeIcon';
import { ParameterContext, type ParameterContextValue } from '../parameters/context';
import { ParameterList } from '../parameters/ParameterForm';
import { Button, IconButton } from '../ui/Button';
import { Callout, EmptyState } from '../ui/misc';
import { Tabs } from '../ui/Tabs';
import { InputPane, OutputPane } from './DataPanes';
import { NodeSettingsForm } from './NodeSettingsForm';

export interface NodeDetailsViewProps {
  nodeName: string;
  onClose: () => void;
  readOnly: boolean;
  /** run up to this node (POST /run with destinationNode) */
  onExecuteNode?: (nodeName: string) => void;
  onListen?: (nodeName: string) => void;
}

function TriggerPanel({
  nodeName,
  hasWebhooks,
  eventDescription,
  onListen,
  onExecute,
  readOnly,
}: {
  nodeName: string;
  hasWebhooks: boolean;
  eventDescription?: string;
  onListen?: () => void;
  onExecute?: () => void;
  readOnly: boolean;
}) {
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const testWebhook = useRunStore((s) => s.testWebhook);
  const urls = useWebhookUrls(workflowId, hasWebhooks);
  const mine = urls.data?.filter((u) => u.nodeName === nodeName) ?? [];
  const listening = testWebhook?.nodeName === nodeName;
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div>
        <p className="font-display text-md font-semibold">This node starts the workflow</p>
        <p className="mt-1 text-sm text-ink-2">
          {hasWebhooks
            ? 'Call the test URL to send it an event. The data appears on the right.'
            : 'Execute it to see the data it produces.'}
        </p>
      </div>
      {hasWebhooks && !workflowId && (
        <Callout tone="info">Save the workflow to get its webhook URLs.</Callout>
      )}
      {mine.map((u) => (
        <div key={`${u.method}-${u.testUrl}`} className="flex flex-col gap-2">
          {[
            { label: 'Test URL', url: listening ? testWebhook.testUrl : u.testUrl },
            { label: 'Production URL', url: u.productionUrl },
          ].map((entry) => (
            <div key={entry.label}>
              <p className="mb-1 text-xs font-semibold text-ink-2">{entry.label}</p>
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5">
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-2xs font-bold text-ink-2">
                  {u.method}
                </span>
                <code className="min-w-0 flex-1 truncate text-xs" title={entry.url}>
                  {entry.url}
                </code>
                <IconButton
                  label={`Copy ${entry.label.toLowerCase()}`}
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard?.writeText(entry.url).then(
                      () => toast.success('Copied'),
                      () => undefined,
                    )
                  }
                >
                  <Copy size={13} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      ))}
      {!readOnly && (
        <div className="flex flex-col items-start gap-2">
          {hasWebhooks && onListen ? (
            listening ? (
              <Callout tone="info" title="Listening for a test event">
                {eventDescription ?? 'Waiting for you to call the test URL.'}
              </Callout>
            ) : (
              <Button variant="primary" icon={<Radio size={14} />} onClick={onListen}>
                Listen for test event
              </Button>
            )
          ) : (
            onExecute && (
              <Button variant="primary" icon={<Play size={14} />} onClick={onExecute}>
                Execute step
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function NodeDetailsView({
  nodeName,
  onClose,
  readOnly,
  onExecuteNode,
  onListen,
}: NodeDetailsViewProps) {
  const nodeTypes = useNodeTypes();
  const settings = useSettings();
  const variables = useVariables(!readOnly);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.name === nodeName));
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const pinData = useWorkflowStore((s) => s.pinData);
  const stickyNotes = useWorkflowStore((s) => s.stickyNotes);
  const meta = useWorkflowStore((s) => s.meta);
  const setParameter = useWorkflowStore((s) => s.setParameter);
  const updateNode = useWorkflowStore((s) => s.updateNode);
  const renameNode = useWorkflowStore((s) => s.renameNode);
  const setPinData = useWorkflowStore((s) => s.setPinData);
  const runData = useRunStore((s) => s.runData);
  const previousRunData = useRunStore((s) => s.previousRunData);
  const runningNodes = useRunStore((s) => s.runningNodes);
  const executionId = useRunStore((s) => s.executionId);
  const runStatus = useRunStore((s) => s.status);
  const openNdv = useUiStore((s) => s.openNdv);
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  const [name, setName] = useState(nodeName);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setName(nodeName), [nodeName]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-ndv])')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const description = node ? nodeTypes.get(node.type) : undefined;
  const ports = useMemo(() => (node ? deriveNodePorts(node, description) : null), [node, description]);
  const graph = useMemo(
    () => ({ nodes, connections, pinData, stickyNotes }),
    [nodes, connections, pinData, stickyNotes],
  );
  const effectiveRunData = useMemo(() => withPinnedData(runData, pinData), [runData, pinData]);
  const variableMap = useMemo(
    () => Object.fromEntries((variables.data ?? []).map((v) => [v.key, v.value])),
    [variables.data],
  );

  const expressionContext = useMemo(() => {
    if (!node) return null;
    return buildExpressionContext({
      workflow: { id: meta.id, name: meta.name, active: meta.active, nodes, connections },
      runData,
      pinData,
      nodeName: node.name,
      variables: variableMap,
      timezone: meta.settings.timezone ?? settings.timezone,
      executionId: executionId ?? undefined,
      parameters: node.parameters,
    });
  }, [node, meta, nodes, connections, runData, pinData, variableMap, settings.timezone, executionId]);

  const completions = useCallback((): CompletionData | undefined => {
    if (!node) return undefined;
    const input = resolveInput(
      { id: meta.id, name: meta.name, active: meta.active, nodes, connections },
      effectiveRunData,
      node.name,
    );
    const inputSchema = flattenSchema(inferSchema(input.items));
    const keysAt = (schema: ReturnType<typeof flattenSchema>, path: Array<string | number>) =>
      schema
        .filter(
          (f) =>
            f.path.length === path.length + 1 &&
            path.every((p, i) => f.path[i] === p || (typeof p === 'number' && f.path[i] === 0)),
        )
        .map((f) => String(f.path[f.path.length - 1]))
        .filter((k, i, all) => all.indexOf(k) === i && k !== '0');
    return {
      inputFields: (path) => keysAt(inputSchema, path),
      nodeNames: nodes.map((n) => n.name),
      nodeFields: (other, path) =>
        keysAt(flattenSchema(inferSchema(getNodeOutput(effectiveRunData, other) ?? [])), path),
      variables: Object.keys(variableMap),
    };
  }, [node, meta, nodes, connections, effectiveRunData, variableMap]);

  const parameterContext: ParameterContextValue | null = useMemo(() => {
    if (!node) return null;
    return {
      node,
      description,
      rootValues: node.parameters,
      readOnly,
      allowExpressions: true,
      onChange: (path, value) => setParameter(node.name, path, value),
      preview: (expression: string) =>
        expressionContext
          ? previewExpression(expression, expressionContext)
          : { ok: false, error: 'No context' },
      completions,
      onButton: onExecuteNode ? (_prop: NodeProperty) => onExecuteNode(node.name) : undefined,
    };
  }, [node, description, readOnly, setParameter, expressionContext, completions, onExecuteNode]);

  if (!node || !ports || !parameterContext) {
    return null;
  }

  const commitRename = () => {
    const next = name.trim();
    if (!next || next === node.name) {
      setName(node.name);
      return;
    }
    try {
      renameNode(node.name, next);
      openNdv(next);
    } catch (error) {
      toast.error('Could not rename the node', error instanceof RenameError ? error.message : String(error));
      setName(node.name);
    }
  };

  const hasMainInput = ports.inputs.some((p) => p.type === 'main');
  const running = runningNodes.includes(node.name) || runStatus === 'starting';
  const docsUrl =
    description?.documentationUrl && /^https?:\/\//.test(description.documentationUrl)
      ? description.documentationUrl
      : null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex bg-[color-mix(in_oklab,var(--wf-ink)_42%,transparent)] p-[2vh_1.5vw] backdrop-blur-[2px]">
      <button
        type="button"
        aria-label="Close node details"
        tabIndex={-1}
        className="fixed inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${node.name} details`}
        data-ndv
        tabIndex={-1}
        className="relative flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-lift outline-none"
      >
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <span
            className="grid size-9 place-items-center rounded-lg bg-surface-3"
            style={{ color: node.color ?? description?.iconColor }}
          >
            <NodeIcon description={description} fallbackName={node.type} size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <input
              aria-label="Node name"
              className="w-full max-w-md rounded-md border border-transparent bg-transparent px-1 font-display text-lg font-semibold hover:border-line focus:border-brand focus:outline-none"
              value={name}
              readOnly={readOnly}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setName(node.name);
                }
              }}
            />
            <p className="px-1 text-xs text-ink-3">{description?.displayName ?? node.type}</p>
          </div>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-brand"
            >
              <BookOpen size={14} /> Docs
            </a>
          )}
          {!readOnly && onExecuteNode && !ports.isSubNode && (
            <Button
              variant="primary"
              icon={<Play size={14} />}
              onClick={() => onExecuteNode(node.name)}
              loading={running}
            >
              Execute step
            </Button>
          )}
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <ParameterContext.Provider value={parameterContext}>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.15fr)_minmax(0,1fr)]">
            <section aria-label="Input" className="hidden min-h-0 flex-col lg:flex">
              <h2 className="px-3 pt-3 font-sans text-xs font-semibold text-ink-3">Input</h2>
              <div className="min-h-0 flex-1">
                {ports.isSubNode ? (
                  <EmptyState
                    title="Sub-nodes have no direct input"
                    description="The root node they are attached to calls them with its own data."
                  />
                ) : hasMainInput ? (
                  <InputPane
                    graph={graph}
                    node={node}
                    runData={effectiveRunData}
                    readOnly={readOnly}
                    onExecuteParent={
                      onExecuteNode && !readOnly ? (parent) => onExecuteNode(parent) : undefined
                    }
                  />
                ) : (
                  <TriggerPanel
                    nodeName={node.name}
                    hasWebhooks={Boolean(description?.webhooks?.length)}
                    eventDescription={description?.eventTriggerDescription}
                    onListen={onListen ? () => onListen(node.name) : undefined}
                    onExecute={onExecuteNode ? () => onExecuteNode(node.name) : undefined}
                    readOnly={readOnly}
                  />
                )}
              </div>
            </section>
            <section
              aria-label="Parameters"
              className="flex min-h-0 flex-col border-x border-line bg-surface"
            >
              <div className="px-4 pt-3">
                <Tabs
                  label="Node configuration"
                  value={tab}
                  onChange={setTab}
                  items={[
                    { value: 'parameters', label: 'Parameters' },
                    { value: 'settings', label: 'Settings' },
                  ]}
                  className="border-b border-line"
                />
              </div>
              <div className="wf-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {!description && (
                  <Callout tone="err" title="Unknown node type" className="mb-4">
                    “{node.type}” is not installed on this server. Its parameters are kept as they are.
                  </Callout>
                )}
                {tab === 'parameters' ? (
                  <div className="flex flex-col gap-4">
                    {description && (
                      <NodeCredentials
                        node={node}
                        description={description}
                        readOnly={readOnly}
                        onChange={(credentials) => updateNode(node.name, { credentials })}
                      />
                    )}
                    {description && (
                      <ParameterList
                        properties={description.properties}
                        values={node.parameters}
                        path={[]}
                        filter={(p) => !p.isNodeSetting}
                      />
                    )}
                    {description && description.properties.filter((p) => !p.isNodeSetting).length === 0 && (
                      <p className="text-sm text-ink-3">This node has no parameters.</p>
                    )}
                  </div>
                ) : (
                  <NodeSettingsForm
                    node={node}
                    description={description}
                    readOnly={readOnly}
                    onChange={(patch) => updateNode(node.name, patch)}
                  />
                )}
              </div>
            </section>
            <section aria-label="Output" className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1">
                <OutputPane
                  node={node}
                  description={description}
                  ports={ports}
                  runData={runData}
                  previousRunData={previousRunData}
                  pinned={pinData[node.name]}
                  readOnly={readOnly}
                  running={running}
                  onPin={(items) => setPinData(node.name, items)}
                  onExecute={onExecuteNode ? () => onExecuteNode(node.name) : undefined}
                />
              </div>
            </section>
          </div>
        </ParameterContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
