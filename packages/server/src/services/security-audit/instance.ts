/**
 * P6-54 (L9): the instance category of the security audit. Instance: unprotected webhooks (authentication none, no validator child) and the workspace settings (workflow reviews, redaction floor, policy default).
 * Only this workspace's values are read; platform environment values are never part of a report.
 */
import type { ServiceDeps } from '../../context';
import type { TenantSettings } from '../../plans';
import { floorOf } from '../redaction/policy';
import {
  type AuditLocation,
  type AuditRiskReport,
  type AuditRunOptions,
  type AuditSection,
  type AuditWorkflow,
  eachWorkflow,
  nodeLocation,
} from './types';

const WEBHOOK_TYPE = 'core.webhook';
/** a node right after the Webhook that can refuse a caller */
const VALIDATOR_TYPES = new Set(['core.if', 'core.switch', 'core.code']);

/** the names of the nodes a node's main outputs connect to */
function childNames(workflow: AuditWorkflow, nodeName: string): string[] {
  const outputs = (workflow.connections as Record<string, { main?: unknown }> | null)?.[nodeName]?.main;
  if (!Array.isArray(outputs)) return [];
  const names: string[] = [];
  for (const branch of outputs) {
    if (!Array.isArray(branch)) continue;
    for (const link of branch) {
      const name = (link as { node?: unknown } | null)?.node;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

/** null when the category finds no risk */
export async function instanceReport(
  deps: ServiceDeps,
  tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  const unprotected: AuditLocation[] = [];
  await eachWorkflow(deps, tenantId, (workflow) => {
    if (workflow.isArchived) return;
    for (const node of workflow.nodes) {
      if (node.type !== WEBHOOK_TYPE || node.disabled) continue;
      const authentication = (node.parameters as Record<string, unknown> | undefined)?.authentication;
      if (authentication !== undefined && authentication !== 'none') continue;
      const validated = childNames(workflow, node.name).some((name) => {
        const child = workflow.nodes.find((candidate) => candidate.name === name);
        return !!child && VALIDATOR_TYPES.has(child.type);
      });
      if (!validated) unprotected.push(nodeLocation(workflow, node));
    }
  });

  const sections: AuditSection[] = [];
  if (unprotected.length > 0) {
    sections.push({
      title: 'Webhooks that anyone can call',
      description:
        'These Webhook nodes have no authentication, and no If, Switch or Code node right after them checks the caller.',
      recommendation: 'Turn on authentication in the Webhook node, or check the caller right after it.',
      location: unprotected,
    });
  }

  const weak = await weakSettings(deps, tenantId);
  if (Object.keys(weak).length > 0) {
    sections.push({
      title: 'Workspace security settings that are not hardened',
      description:
        'These workspace settings are at their permissive values: workflow reviews are off, run data is not redacted by default, or a type policy allows everything by default.',
      recommendation:
        'Turn on workflow reviews, set a redaction floor, and make the policies deny by default where that fits.',
      settings: weak,
    });
  }
  return sections.length > 0 ? { risk: 'instance', sections } : null;
}

/** the workspace's own settings that are permissive, by name (no platform value) */
async function weakSettings(deps: ServiceDeps, tenantId: string): Promise<Record<string, unknown>> {
  const tenant = await deps.repos.tenants.get(tenantId);
  const settings = (tenant?.settings ?? {}) as TenantSettings;
  const weak: Record<string, unknown> = {};
  if (settings.workflowReviews?.enabled !== true) weak.workflowReviews = 'off';
  const floor = floorOf(tenant);
  if (floor === 'off') weak.redactionFloor = floor;
  const policies = deps.context().typePolicies;
  const node = await policies.getScope(tenantId, 'node', null);
  if (node.defaultAction === 'allow') weak.nodeTypePolicyDefault = node.defaultAction;
  const credential = await policies.getScope(tenantId, 'credential', null);
  if (credential.defaultAction === 'allow') weak.credentialTypePolicyDefault = credential.defaultAction;
  return weak;
}
