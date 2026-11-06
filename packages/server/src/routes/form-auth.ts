/**
 * /rest/form-auth (P4-16). FormSignInPage calls it with the session; any member may ask, and only for
 * themselves. returnTo must be a form path on this server, so the page cannot be used to redirect
 * elsewhere.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';
import type { FormAuthService } from '../services/form-auth';

const codeBody = z.object({
  returnTo: z
    .string()
    .max(2048)
    .regex(/^\/form(-test|-waiting)?\//),
});

export function registerFormAuthRoutes(app: FastifyInstance, deps: { formAuth: FormAuthService }): void {
  const { formAuth } = deps;

  app.post('/form-auth/code', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { returnTo } = parse(codeBody, request.body);
    return { data: { code: await formAuth.issueCode(auth.user.id, returnTo) } };
  });
}
