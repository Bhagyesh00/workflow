/**
 * Public API security audit (P6-54, L9), as n8n's audit public controller: POST `/audit` generates the report
 * (credentials, database, nodes, filesystem, workspace), `securityAudit:generate` for the user and the key. The
 * body is `{ additionalOptions: { daysAbandonedWorkflow, categories } }`. PUBLIC_AUDIT_ROUTES is final and shaped
 * as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it). The handler is a stub until L9 fills it.
 */
import type { ApiRoute } from './public-api';

export const PUBLIC_AUDIT_ROUTES: ApiRoute[] = [
  {
    method: 'POST',
    path: '/audit',
    summary: 'Generate a security audit of the workspace',
    tag: 'Audit',
    access: { scope: 'securityAudit:generate' },
    scope: 'securityAudit:generate',
    response: 'SecurityAuditReport',
    handler: async () => {
      // stub (L9)
      throw new Error('not implemented (L9)');
    },
  },
];
