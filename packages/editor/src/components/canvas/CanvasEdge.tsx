/** Cable between two ports: item count after a run, insert/delete buttons on hover. */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { plural } from '../../lib/format';
import { useCanvasActions } from './actions';
import type { CableEdge } from './flow-elements';

export const CanvasEdge = memo(function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<CableEdge>) {
  const actions = useCanvasActions();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  });
  const showTools = Boolean(data && !data.readOnly && (data.hovered || selected));
  return (
    <>
      <g
        data-kind={data?.kind}
        data-category={data?.category}
        data-has-data={(data?.count ?? 0) > 0 || undefined}
      >
        <BaseEdge id={id} path={path} className="wf-cable" interactionWidth={22} />
      </g>
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-none absolute flex flex-col items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {data?.count !== undefined && (
            <span
              className="rounded-full border border-ok/40 bg-surface px-1.5 py-px text-2xs font-semibold text-ok shadow-card"
              data-testid="edge-count"
            >
              {plural(data.count, 'item')}
            </span>
          )}
          {data && !data.readOnly && (
            <div className="wf-edge-toolbar static" data-visible={showTools}>
              {data.kind === 'main' && (
                <button
                  type="button"
                  aria-label="Insert a node on this connection"
                  title="Insert node"
                  className="grid size-6 place-items-center rounded-md border border-line bg-surface text-ink-2 shadow-card hover:border-brand hover:text-brand"
                  onClick={() => actions.insertOnEdge(data.ref)}
                >
                  <Plus size={13} />
                </button>
              )}
              <button
                type="button"
                aria-label="Delete connection"
                title="Delete connection"
                className="grid size-6 place-items-center rounded-md border border-line bg-surface text-ink-2 shadow-card hover:border-err hover:text-err"
                onClick={() => actions.removeEdge(data.ref)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
