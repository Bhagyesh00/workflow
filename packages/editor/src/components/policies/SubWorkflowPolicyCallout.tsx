/**
 * P6-50 (L5): NDV callout on an Execute Workflow node whose sub-workflow would not start under the
 * policies (`typePoliciesApi.subWorkflowPolicyCheck`).
 */

import { useQuery } from '@tanstack/react-query';
import type { WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';
import { typePoliciesApi } from '../../api/endpoints';
import { subWorkflowTargets } from '../../features/editor/open-resources';
import { violationText } from '../../lib/policy-violations';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Callout } from '../ui/misc';

export interface SubWorkflowPolicyCalloutProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

export function SubWorkflowPolicyCallout({ node }: SubWorkflowPolicyCalloutProps): ReactNode {
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const subId = subWorkflowTargets([node])[0]?.workflowId;
  const check = useQuery({
    queryKey: ['sub-workflow-policy-check', workflowId ?? 'new', subId ?? 'none'],
    queryFn: () => typePoliciesApi.subWorkflowPolicyCheck(workflowId!, subId!),
    enabled: Boolean(workflowId && subId),
    retry: false,
    staleTime: 30_000,
  });
  if (!check.data || check.data.allowed) return null;
  const violations = check.data.violations;
  return (
    <Callout tone="warn" title="The workflow this node calls would not start" className="mb-4">
      <p>The policies block node types in that workflow, so a run of this node would fail.</p>
      {violations.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {violations.map((v) => (
            <li key={`${v.type}:${v.nodeName ?? ''}:${v.scope}`}>{violationText(v, v.nodeName)}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}
