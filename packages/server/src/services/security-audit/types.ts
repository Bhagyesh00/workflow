/**
 * P6-54 (L9): the shapes of the security audit report (n8n's report keys and section shape; texts in our
 * words). Platform env values are never part of a report.
 * Types from C0; L9 may add fields it needs.
 */

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
  categories: AuditCategory[];
}
