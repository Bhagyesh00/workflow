/**
 * Canvas module for a workflow node. Main ports sit on the left/right, AI inputs of root nodes
 * along the bottom with labels, and sub-nodes are round with their output on top.
 */

import type { DirtyReason } from '@workflow/workflow';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import {
  AlertTriangle,
  Check,
  MoreHorizontal,
  StickyNote as NoteIcon,
  Pin,
  Play,
  Plus,
  Power,
  Trash2,
  X,
} from 'lucide-react';
import { memo } from 'react';
import type { PortSpec } from '../../lib/ports';
import { NodeIcon } from '../NodeIcon';
import { CanvasLockBadge } from '../policies/CanvasLockBadge';
import { cx } from '../ui/cx';
import { Spinner } from '../ui/misc';
import { useCanvasActions } from './actions';
import type { WorkflowFlowNode } from './flow-elements';

const ROW = 26;

export function nodeHeight(mainIn: number, mainOut: number): number {
  return Math.max(64, ROW * Math.max(mainIn, mainOut) + 16);
}

function spread(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

/** P3-06: n8n's two tooltips for a node whose output is stale */
export function dirtyTooltip(reason: DirtyReason): string {
  return reason === 'parameters'
    ? 'Node configuration changed. Output data may change when this node is run again'
    : 'Because of changes in the workflow, output data may change when this node is run again';
}

function StatusBadge({
  status,
  pinned,
  errors,
  dirty,
}: {
  status: string | undefined;
  pinned: boolean;
  errors: number;
  dirty?: DirtyReason;
}) {
  if (status === 'running') {
    return (
      <span className="wf-node-badge bg-run" title="Running">
        <Spinner size={11} />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="wf-node-badge bg-err" title="Failed">
        <X size={11} strokeWidth={3} />
      </span>
    );
  }
  if (pinned) {
    return (
      <span className="wf-node-badge bg-pin" title="Output is pinned">
        <Pin size={10} strokeWidth={2.6} />
      </span>
    );
  }
  if (dirty && status) {
    return (
      <span className="wf-node-badge bg-warn" title={dirtyTooltip(dirty)} data-dirty={dirty}>
        <AlertTriangle size={10} strokeWidth={2.6} />
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="wf-node-badge bg-ok" title="Succeeded">
        <Check size={11} strokeWidth={3} />
      </span>
    );
  }
  if (errors > 0) {
    return (
      <span className="wf-node-badge bg-warn" title={`${errors} issue${errors === 1 ? '' : 's'} to fix`}>
        <AlertTriangle size={10} strokeWidth={2.6} />
      </span>
    );
  }
  return null;
}

function NodeToolbar({
  name,
  disabled,
  readOnly,
  canExecute,
}: {
  name: string;
  disabled: boolean;
  readOnly: boolean;
  canExecute: boolean;
}) {
  const actions = useCanvasActions();
  if (readOnly) return null;
  const button = 'grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink';
  return (
    <div className="nodrag nopan absolute -top-10 left-1/2 hidden -translate-x-1/2 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-card group-hover:flex group-[.selected]:flex">
      {canExecute && actions.executeNode && (
        <button
          type="button"
          className={button}
          title="Execute step"
          aria-label={`Execute ${name}`}
          onClick={() => actions.executeNode?.(name)}
        >
          <Play size={13} />
        </button>
      )}
      <button
        type="button"
        className={button}
        title={disabled ? 'Activate' : 'Deactivate'}
        aria-label={`${disabled ? 'Activate' : 'Deactivate'} ${name}`}
        onClick={() => actions.toggleDisabled(name)}
      >
        <Power size={13} />
      </button>
      <button
        type="button"
        className={`${button} hover:text-err`}
        title="Delete"
        aria-label={`Delete ${name}`}
        onClick={() => actions.removeNode(name)}
      >
        <Trash2 size={13} />
      </button>
      {actions.openContextMenu && (
        <button
          type="button"
          className={button}
          title="More"
          aria-label={`More actions for ${name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            actions.openContextMenu?.(name, { x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      )}
    </div>
  );
}

function OutputPlus({
  nodeName,
  port,
  style,
}: {
  nodeName: string;
  port: PortSpec;
  style: React.CSSProperties;
}) {
  const actions = useCanvasActions();
  return (
    <button
      type="button"
      className="nodrag nopan absolute grid size-5 place-items-center rounded-md border border-line-strong bg-surface text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 hover:border-brand hover:text-brand"
      style={style}
      aria-label={`Add a node after ${nodeName}${port.label ? ` (${port.label})` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        actions.addFromOutput(nodeName, port.type, port.index);
      }}
    >
      <Plus size={12} />
    </button>
  );
}

export const CanvasNode = memo(function CanvasNode({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const {
    node,
    description,
    ports,
    status,
    pinned,
    subtitle,
    issues,
    readOnly,
    connectedOutputs,
    connectedInputs,
    dirty,
  } = data;
  const actions = useCanvasActions();
  const errors = issues.filter((i) => i.severity === 'error').length;
  const color = node.color ?? description?.defaults.color ?? description?.iconColor;
  const mainIn = ports.inputs.filter((p) => p.type === 'main');
  const mainOut = ports.outputs.filter((p) => p.type === 'main');
  const aiIn = ports.inputs.filter((p) => p.type !== 'main');
  const aiOut = ports.outputs.filter((p) => p.type !== 'main');
  const title = node.name;

  if (ports.isSubNode) {
    return (
      <div
        className={cx('wf-subnode-wrap group relative flex flex-col items-center', selected && 'selected')}
        style={{ width: 120 }}
      >
        <NodeToolbar
          name={node.name}
          disabled={Boolean(node.disabled)}
          readOnly={readOnly}
          canExecute={false}
        />
        <div
          className="wf-subnode"
          data-status={status}
          data-disabled={node.disabled || undefined}
          style={{ ['--wf-node-color' as string]: color }}
        >
          <span className="wf-node-icon !size-11 !rounded-full">
            <NodeIcon description={description} fallbackName={node.type} size={22} />
          </span>
          {aiOut.map((port, i) => (
            <Handle
              key={port.id}
              id={port.id}
              type="source"
              position={Position.Top}
              className="wf-port"
              data-kind="ai"
              isConnectable={!readOnly}
              style={{ left: spread(i, aiOut.length) }}
            />
          ))}
          {aiIn.map((port, i) => (
            <Handle
              key={port.id}
              id={port.id}
              type="target"
              position={Position.Bottom}
              className="wf-port"
              data-kind="ai"
              data-required={port.required && !connectedInputs.includes(port.id) ? 'true' : undefined}
              isConnectable={!readOnly}
              style={{ left: spread(i, aiIn.length) }}
            />
          ))}
          <StatusBadge status={status} pinned={pinned} errors={errors} dirty={dirty} />
          <CanvasLockBadge nodeType={node.type} />
        </div>
        <p
          className="wf-node-title mt-2 max-w-[140px] text-center text-xs leading-tight font-semibold text-ink"
          title={title}
        >
          {title}
        </p>
        {aiIn.length > 0 && (
          <div className="mt-1 flex gap-2 text-2xs text-ink-3">
            {aiIn.map((p) => (
              <span key={p.id}>{p.label}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isRoot = aiIn.length > 0;
  const width = isRoot ? Math.max(260, aiIn.length * 92) : 220;
  const height = nodeHeight(mainIn.length, mainOut.length);
  return (
    <div className={cx('group relative', selected && 'selected')} style={{ width }}>
      <NodeToolbar
        name={node.name}
        disabled={Boolean(node.disabled)}
        readOnly={readOnly}
        canExecute={!ports.isSubNode}
      />
      <div
        className="wf-node"
        data-status={status}
        data-trigger={ports.isTrigger || undefined}
        data-disabled={node.disabled || undefined}
        data-selected={selected || undefined}
        style={{ minHeight: height, ['--wf-node-color' as string]: color }}
      >
        <span className="wf-node-icon">
          <NodeIcon description={description} fallbackName={node.type} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="wf-node-title truncate text-sm font-semibold" title={title}>
            {title}
          </p>
          <p className="truncate text-xs text-ink-2">
            {node.disabled
              ? 'Deactivated'
              : !description
                ? 'Unknown node type'
                : (subtitle ?? description.displayName)}
          </p>
        </div>
        {node.notes && node.notesInFlow && (
          <NoteIcon size={12} className="shrink-0 text-ink-3" aria-label="Has notes" />
        )}

        {mainIn.map((port, i) => (
          <Handle
            key={port.id}
            id={port.id}
            type="target"
            position={Position.Left}
            className="wf-port"
            data-kind="main"
            isConnectable={!readOnly}
            style={{ top: spread(i, mainIn.length) }}
          >
            {mainIn.length > 1 && (
              <span className="wf-port-label" style={{ right: 16, top: -14 }}>
                {port.label ?? `Input ${i + 1}`}
              </span>
            )}
          </Handle>
        ))}
        {mainOut.map((port, i) => (
          <Handle
            key={port.id}
            id={port.id}
            type="source"
            position={Position.Right}
            className="wf-port"
            data-kind="main"
            data-category={port.category}
            isConnectable={!readOnly}
            style={{ top: spread(i, mainOut.length) }}
          >
            {(port.label || mainOut.length > 1) && (
              <span
                className="wf-port-label"
                style={{ left: 16, top: -15, color: port.category === 'error' ? 'var(--wf-err)' : undefined }}
              >
                {port.label ?? `Output ${i + 1}`}
              </span>
            )}
          </Handle>
        ))}
        {!readOnly &&
          mainOut
            .filter((p) => !connectedOutputs.includes(p.id))
            .map((port) => (
              <OutputPlus
                key={`plus-${port.id}`}
                nodeName={node.name}
                port={port}
                style={{ right: -40, top: `calc(${spread(mainOut.indexOf(port), mainOut.length)} - 10px)` }}
              />
            ))}
        {aiOut.map((port, i) => (
          <Handle
            key={port.id}
            id={port.id}
            type="source"
            position={Position.Top}
            className="wf-port"
            data-kind="ai"
            isConnectable={!readOnly}
            style={{ left: spread(i, aiOut.length) }}
          />
        ))}
        <StatusBadge status={status} pinned={pinned} errors={errors} dirty={dirty} />
        <CanvasLockBadge nodeType={node.type} />
      </div>
      {isRoot && (
        // AI inputs hang below the module: label, "+" to add a sub-node, then the port itself,
        // so cables from sub-nodes arrive underneath the labels instead of crossing them
        <div className="relative mt-1.5 h-[60px]">
          {aiIn.map((port, i) => {
            const used = connectedInputs.filter((id) => id === port.id).length;
            const full = port.maxConnections !== undefined && used >= port.maxConnections;
            return (
              <div
                key={port.id}
                className="absolute top-0 bottom-0 flex w-24 -translate-x-1/2 flex-col items-center gap-1"
                style={{ left: spread(i, aiIn.length) }}
              >
                <span
                  className={cx(
                    'text-2xs whitespace-nowrap',
                    port.required ? 'font-semibold text-ink-2' : 'text-ink-3',
                  )}
                >
                  {port.label}
                  {port.required && '*'}
                </span>
                {!readOnly && !full && (
                  <button
                    type="button"
                    className="nodrag nopan grid size-5 place-items-center rounded-md border border-dashed border-line-strong bg-surface text-ink-3 hover:border-brand hover:text-brand"
                    aria-label={`Add ${port.label ?? port.type} to ${node.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.addSubNode(node.name, port.type, port.index);
                    }}
                  >
                    <Plus size={11} />
                  </button>
                )}
                <Handle
                  id={port.id}
                  type="target"
                  position={Position.Bottom}
                  className="wf-port"
                  data-kind="ai"
                  data-required={port.required && !used ? 'true' : undefined}
                  isConnectable={!readOnly}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
