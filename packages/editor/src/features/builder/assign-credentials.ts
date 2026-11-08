/**
 * P5-62: nodes of the draft that need a credential and have none get the first credential of each
 * type the user can use (n8n's rule); runs in the browser only, and the diff shows it. The model never
 * sees a credential: the server drops any it writes, so a credential on a draft node comes from here or
 * was on the canvas before.
 */
import {
  type NodeCredentialRef,
  type NodeTypeDescription,
  nodeCredentialSlots,
  resolveNodeParameters,
  type WorkflowNode,
} from '@workflow/workflow';
import type { CredentialSummary } from '../../api/types';

/**
 * For each credential slot a node shows (its displayOptions applied to the node's parameters, as the
 * credential section of the node panel shows them) with no credential in it, the first credential of
 * that type in `credentials`. A node with nothing to fill is returned as it is (same object).
 */
export function assignDefaultCredentials(
  nodes: WorkflowNode[],
  credentials: CredentialSummary[],
  descriptions: { get(type: string): NodeTypeDescription | undefined },
): WorkflowNode[] {
  const firstOfType = new Map<string, CredentialSummary>();
  for (const credential of credentials) {
    if (!firstOfType.has(credential.type)) firstOfType.set(credential.type, credential);
  }
  if (!firstOfType.size) return nodes;
  return nodes.map((node) => {
    const description = descriptions.get(node.type);
    if (!description) return node;
    const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
      nodeVersion: node.typeVersion,
    });
    let assigned: Record<string, NodeCredentialRef> | undefined = node.credentials;
    for (const slot of nodeCredentialSlots(description, params, node.typeVersion)) {
      if (assigned?.[slot.name]?.id) continue;
      const credential = firstOfType.get(slot.name);
      if (!credential) continue;
      assigned = { ...assigned, [slot.name]: { id: credential.id, name: credential.name } };
    }
    return assigned === node.credentials ? node : { ...node, credentials: assigned };
  });
}
