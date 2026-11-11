/**
 * P6-50 (L5): NDV panel for a node whose type a policy blocks: "This node is restricted", with
 * "Replace node" (lib/replace-node.ts). Mounted by NodeDetailsView for every node; renders nothing
 * for an available type.
 */

import type { WorkflowNode } from '@workflow/workflow';
import { type ReactNode, useState } from 'react';
import { restrictedReason, useRestrictedEntry } from '../../lib/policy-violations';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { Button } from '../ui/Button';
import { Callout } from '../ui/misc';
import { ContactAdminDialog } from './ContactAdminDialog';

export interface RestrictedNodePanelProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

export function RestrictedNodePanel({ node }: RestrictedNodePanelProps): ReactNode {
  const entry = useRestrictedEntry(node.type);
  const readOnly = useWorkflowStore((s) => s.readOnly);
  const [contact, setContact] = useState(false);
  if (!entry) return null;

  const replace = () => {
    const ui = useUiStore.getState();
    ui.openNdv(null);
    ui.openCreator();
    ui.setReplaceTarget(node.name);
  };

  return (
    <Callout tone="err" title="This node is restricted" className="mb-4">
      <p>{restrictedReason(entry)}</p>
      <p className="mt-1">
        It can stay in the workflow, but the workflow will not save, publish or run with it.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!readOnly && (
          <Button size="sm" variant="secondary" onClick={replace}>
            Replace node
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setContact(true)}>
          Contact admin
        </Button>
      </div>
      <ContactAdminDialog
        open={contact}
        onClose={() => setContact(false)}
        type={node.type}
        displayName={node.name}
      />
    </Callout>
  );
}
