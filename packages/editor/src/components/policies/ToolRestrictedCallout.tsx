/**
 * P6-50 (L5): NDV callout on an agent whose connected tool types a policy blocks.
 */

import type { WorkflowNode } from '@workflow/workflow';
import { type ReactNode, useMemo } from 'react';
import { useRestrictedTypes } from '../../lib/policy-violations';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Callout } from '../ui/misc';

export interface ToolRestrictedCalloutProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

export function ToolRestrictedCallout({ node }: ToolRestrictedCalloutProps): ReactNode {
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const { restricted } = useRestrictedTypes();
  const blocked = useMemo(() => {
    if (restricted.size === 0) return [];
    const names: string[] = [];
    for (const [source, byType] of Object.entries(connections)) {
      const feeds = (byType.ai_tool ?? []).some((list) => (list ?? []).some((c) => c.node === node.name));
      if (!feeds) continue;
      const tool = nodes.find((n) => n.name === source);
      if (tool && restricted.has(tool.type)) names.push(tool.name);
    }
    return names;
  }, [restricted, connections, nodes, node.name]);
  if (blocked.length === 0) return null;
  return (
    <Callout tone="warn" title="Some tools of this node are restricted" className="mb-4">
      <p>
        A policy blocks {blocked.length === 1 ? 'this tool' : 'these tools'}: {blocked.join(', ')}. The agent
        cannot call {blocked.length === 1 ? 'it' : 'them'}, and the workflow will not publish or run until{' '}
        {blocked.length === 1 ? 'it is' : 'they are'} replaced or allowed. A newly added tool of this kind
        will not save.
      </p>
    </Callout>
  );
}
