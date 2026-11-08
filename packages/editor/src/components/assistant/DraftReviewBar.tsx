/**
 * P5-62: shown while a draft is under review (`useBuilderStore` `reviewing`): `Edits · {count} nodes`,
 * the diff against the snapshot (`WorkflowDiffSummary` plus `ParameterDiff` with the old and new value of
 * every change, so URLs and code are read before they are saved), Run draft, Accept and Discard. Nothing
 * is saved until Accept; Discard loads the snapshot back and sends nothing.
 */
import {
  diffWorkflows,
  type NodeChange,
  type ValueChange,
  type WorkflowDiff,
  type WorkflowNode,
} from '@workflow/workflow';
import { Check, ChevronDown, ChevronRight, Play, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBuilderStore } from '../../stores/builder-store';
import { useRunStore } from '../../stores/run-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';
import { WorkflowDiffSummary } from '../workflow/WorkflowDiffSummary';
import { ParameterDiff } from './ParameterDiff';

/** nodes the draft adds, removes, renames or changes (each counted once) */
function editedNodeCount(diff: WorkflowDiff): number {
  const ids = new Set<string>();
  for (const n of diff.nodes.added) ids.add(n.id);
  for (const n of diff.nodes.removed) ids.add(n.id);
  for (const n of diff.nodes.renamed) ids.add(n.id);
  for (const n of diff.nodes.changed) ids.add(n.id);
  return ids.size;
}

/** an added node as a change from nothing: each of its parameters (and credentials) before and after */
function addedNodeChange(node: WorkflowNode): NodeChange {
  const changes: ValueChange[] = Object.entries(node.parameters ?? {}).map(([key, value]) => ({
    path: `parameters.${key}`,
    before: undefined,
    after: value,
  }));
  for (const [type, ref] of Object.entries(node.credentials ?? {})) {
    changes.push({ path: `credentials.${type}`, before: undefined, after: ref });
  }
  return { id: node.id, name: node.name, type: node.type, changes };
}

export function DraftReviewBar() {
  const reviewing = useBuilderStore((s) => s.reviewing);
  const snapshot = useBuilderStore((s) => s.snapshot);
  const streaming = useBuilderStore((s) => s.streaming);
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const runStatus = useRunStore((s) => s.status);
  const [open, setOpen] = useState(true);
  const [accepting, setAccepting] = useState(false);

  const diff = useMemo(
    () =>
      snapshot
        ? diffWorkflows(
            { name: '', nodes: snapshot.graph.nodes, connections: snapshot.graph.connections },
            { name: '', nodes, connections },
          )
        : null,
    [snapshot, nodes, connections],
  );
  const valueChanges = useMemo(() => {
    if (!diff) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const added = diff.nodes.added
      .map((a) => byId.get(a.id))
      .filter((n): n is WorkflowNode => Boolean(n))
      .map(addedNodeChange);
    return [...diff.nodes.changed, ...added].filter((c) => c.changes.length > 0);
  }, [diff, nodes]);

  if (!reviewing || !snapshot || !diff) return null;
  const count = editedNodeCount(diff);
  const running = runStatus === 'starting' || runStatus === 'running';

  const accept = async () => {
    setAccepting(true);
    try {
      await useBuilderStore.getState().acceptDraft();
    } finally {
      setAccepting(false);
    }
  };

  return (
    <section
      aria-label="Draft review"
      className="flex flex-col gap-2 border-t border-line bg-surface-2 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold text-ink"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>
            Edits · {count} {count === 1 ? 'node' : 'nodes'}
          </span>
        </button>
        <span className="text-2xs text-ink-2">Not saved</span>
      </div>
      {open && (
        <div className="wf-scroll flex max-h-72 flex-col gap-2 overflow-y-auto">
          <WorkflowDiffSummary diff={diff} label="Changes in the draft" />
          {valueChanges.map((change) => (
            <ParameterDiff key={change.id} change={change} />
          ))}
        </div>
      )}
      <p className="text-2xs text-ink-2">
        Accept saves the draft as a new version. Discard puts the canvas back as it was.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={<Play size={13} />}
          disabled={streaming || running}
          onClick={() => void useBuilderStore.getState().runDraft()}
        >
          Run draft
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={13} />}
          disabled={accepting}
          onClick={() => useBuilderStore.getState().discardDraft()}
        >
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Check size={13} />}
          disabled={streaming || accepting}
          onClick={() => void accept()}
        >
          Accept
        </Button>
      </div>
    </section>
  );
}
