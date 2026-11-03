/**
 * Floating toolbar for a selection of 2+ nodes (P3-04, P3-05): "Group" (Ctrl/Cmd+G), disabled with
 * the rule text when the selection cannot be grouped, and "Convert to sub-workflow" (Alt+X),
 * hidden when it cannot be extracted. Not shown on read-only canvases.
 */
import {
  validateSelectionForExtraction,
  validateSelectionForGrouping,
  type WorkflowDefinition,
} from '@workflow/workflow';
import { Boxes, Group } from 'lucide-react';
import { useMemo } from 'react';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';

export function SelectionToolbar() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const nodeGroups = useWorkflowStore((s) => s.nodeGroups);
  const selected = useWorkflowStore((s) => s.selection.nodes);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const lookup = useWorkflowStore((s) => s.nodeTypeLookup);

  const checks = useMemo(() => {
    if (selected.length < 2) return null;
    const definition: WorkflowDefinition = { name: '', nodes, connections, nodeGroups };
    const names = new Set(selected);
    const ids = nodes.filter((n) => names.has(n.name)).map((n) => n.id);
    return {
      grouping: validateSelectionForGrouping(definition, ids, lookup),
      extraction: validateSelectionForExtraction(definition, ids, lookup),
    };
  }, [selected, nodes, connections, nodeGroups, lookup]);

  if (readOnly || !checks) return null;
  const groupBlocked = checks.grouping[0]?.message;
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-surface p-1 shadow-card"
    >
      <span className="px-2 text-xs font-semibold text-ink-2">{selected.length} selected</span>
      <Button
        size="sm"
        variant="ghost"
        icon={<Group size={14} />}
        disabled={Boolean(groupBlocked)}
        title={groupBlocked ?? 'Group the selected nodes (Ctrl+G)'}
        onClick={() => useWorkflowStore.getState().groupSelection()}
      >
        Group
      </Button>
      {checks.extraction.length === 0 && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Boxes size={14} />}
          title="Convert the selected nodes to a sub-workflow (Alt+X)"
          onClick={() => useUiStore.getState().setConvertOpen(true)}
        >
          Convert to sub-workflow
        </Button>
      )}
    </div>
  );
}
