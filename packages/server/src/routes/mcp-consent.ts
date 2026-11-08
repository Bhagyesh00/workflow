/**
 * /rest/consent/* (P5-14): the consent page's two calls, behind the session and CSRF checks of every
 * `/rest` route. A signed-in user is enough here; the service checks the membership in the flow token's
 * tenant, whatever the session's current tenant (else 403).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';
import { parse } from '../http/errors';
import { approveMcpConsent, mcpConsentDetails } from '../services/mcp/oauth/consent';
import { MCP_SCOPES } from '../services/mcp/types';

/** a flow token is a form token: at most 4096 characters */
const flowToken = z.string().min(1).max(4096);

const detailsQuerySchema = z.object({ flow: flowToken });

const approveBodySchema = z
  .object({
    flow: flowToken,
    approved: z.boolean(),
    scopes: z
      .array(z.string().max(64))
      .max(MCP_SCOPES.length * 2)
      .optional(),
  })
  .strict();

export function registerMcpConsentRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  /** `?flow=<token>`: client name, workspace, resource, scopes, redirect host */
  rest.get('/consent/details', async (request) => {
    const auth = requireAuth(request);
    const { flow } = parse(detailsQuerySchema, request.query ?? {});
    return { data: await mcpConsentDetails(ctx, auth, flow) };
  });

  /** `{ flow, approved, scopes? }`: `{ data: { redirectUrl } }` */
  rest.post('/consent/approve', async (request) => {
    const auth = requireAuth(request);
    const decision = parse(approveBodySchema, request.body ?? {});
    return { data: await approveMcpConsent(ctx, auth, decision) };
  });
}
