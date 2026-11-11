/**
 * P6-54 (L9): the shapes of the security audit report (n8n's report keys and section shape; texts in our
 * words). Platform env values are never part of a report.
 * Types from C0; L9 may add fields it needs.
 */
import type { WorkflowNode } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { WorkflowRow } from '../../db/schema';
import { AUDIT_PAGE_SIZE } from '../../repositories/security-audit';

export const AUDIT_CATEGORIES = ['credentials', 'database', 'nodes', 'filesystem', 'instance'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** where a risk sits */
export type AuditLocation =
  | { kind: 'credential'; id: string; name: string }
  | {
      kind: 'node';
      workflowId: string;
      workflowName: string;
      nodeId: string;
      nodeName: string;
      nodeType: string;
    };

export interface AuditSection {
  title: string;
  description: string;
  recommendation: string;
  location?: AuditLocation[];
  /** the instance category's settings section */
  settings?: Record<string, unknown>;
}

export interface AuditRiskReport {
  risk: AuditCategory;
  sections: AuditSection[];
}

/** by report title (`Credentials Risk Report`, ...); a category with no risk is absent */
export type SecurityAuditReport = Record<string, AuditRiskReport>;

/** POST /audit `{ additionalOptions }` */
export interface SecurityAuditOptions {
  /** default `config.securityAudit.daysAbandonedWorkflow` */
  daysAbandonedWorkflow?: number;
  /** default all; an unknown one is 400 with the valid list */
  categories?: AuditCategory[];
}

/** what each category reads (resolved options) */
export interface AuditRunOptions {
  daysAbandonedWorkflow: number;
  /** the value the caller sent, if any; the only day count a report text may print (never the config default) */
  requestedDaysAbandonedWorkflow?: number;
  categories: AuditCategory[];
}

/** the report title of a category (`Credentials Risk Report`) */
export function auditTitle(category: AuditCategory): string {
  return `${category[0].toUpperCase()}${category.slice(1)} Risk Report`;
}

export type AuditWorkflow = Omit<WorkflowRow, 'nodes'> & { nodes: WorkflowNode[] };

/** the page by page walk over a workspace's workflows that the categories share (200 rows a page, one page held) */
export async function eachWorkflow(
  deps: ServiceDeps,
  tenantId: string,
  visit: (workflow: AuditWorkflow) => void,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const page = await deps.repos.securityAudit.workflowsPage(tenantId, after);
    for (const row of page) {
      const nodes = (Array.isArray(row.nodes) ? row.nodes : []).filter(
        (node): node is WorkflowNode =>
          !!node && typeof node === 'object' && typeof (node as WorkflowNode).type === 'string',
      );
      visit({ ...row, nodes });
    }
    if (page.length < AUDIT_PAGE_SIZE) return;
    after = page[page.length - 1].id;
  }
}

export function nodeLocation(workflow: AuditWorkflow, node: WorkflowNode): AuditLocation {
  return {
    kind: 'node',
    workflowId: workflow.id,
    workflowName: workflow.name,
    nodeId: String(node.id ?? ''),
    nodeName: String(node.name ?? ''),
    nodeType: node.type,
  };
}
