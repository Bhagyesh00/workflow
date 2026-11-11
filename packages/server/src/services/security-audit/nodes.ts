/**
 * P6-54 (L9): the nodes category of the security audit. Nodes: the risky types core.code, core.httpRequest, core.ssh, core.ftp.
 */
import type { ServiceDeps } from '../../context';
import type { AuditLocation, AuditRiskReport, AuditRunOptions } from './types';
import { eachWorkflow, nodeLocation } from './types';

export const RISKY_NODE_TYPES = ['core.code', 'core.httpRequest', 'core.ssh', 'core.ftp'];

/** null when the category finds no risk */
export async function nodesReport(
  deps: ServiceDeps,
  tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  const found: AuditLocation[] = [];
  await eachWorkflow(deps, tenantId, (workflow) => {
    for (const node of workflow.nodes) {
      if (RISKY_NODE_TYPES.includes(node.type)) found.push(nodeLocation(workflow, node));
    }
  });
  if (found.length === 0) return null;
  return {
    risk: 'nodes',
    sections: [
      {
        title: 'Nodes that run code or reach other systems',
        description:
          'The Code, HTTP Request, SSH and FTP nodes can run your own code or send and fetch data from other systems. A mistake or a hostile input in a workflow that uses them has a wide effect.',
        recommendation: 'Review each use, and block the types you do not need with a node type policy.',
        location: found,
      },
    ],
  };
}
