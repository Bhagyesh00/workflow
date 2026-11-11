/**
 * Public API security audit (P6-54, L9), as n8n's audit public controller: POST `/audit` generates the report
 * (credentials, database, nodes, filesystem, workspace), `securityAudit:generate` for the user and the key. The
 * body is `{ additionalOptions: { daysAbandonedWorkflow, categories } }`; an unknown category is a 400 with the
 * valid list. PUBLIC_AUDIT_ROUTES is final and shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 * The report covers the caller's workspace only.
 */
import { z } from 'zod';
import { generateSecurityAudit } from '../services/security-audit';
import type { ApiRoute } from './public-api';

const auditBody = z
  .object({
    additionalOptions: z
      .object({
        daysAbandonedWorkflow: z.number().int().min(1).max(36500).optional(),
        categories: z.array(z.string().max(64)).max(20).optional(),
      })
      .optional(),
  })
  .optional();

export const PUBLIC_AUDIT_ROUTES: ApiRoute[] = [
  {
    method: 'POST',
    path: '/audit',
    summary: 'Generate a security audit of the workspace',
    tag: 'Audit',
    access: { scope: 'securityAudit:generate' },
    scope: 'securityAudit:generate',
    body: auditBody,
    response: 'SecurityAuditReport',
    handler: async (ctx, { auth, body }) => ({
      data: await generateSecurityAudit(ctx.serviceDeps, auth.tenant.id, body?.additionalOptions ?? {}),
    }),
  },
];
