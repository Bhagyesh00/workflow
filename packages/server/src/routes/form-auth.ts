/**
 * /rest/form-auth (P4-16). FormSignInPage calls it with the session; any member may ask, and only for
 * themselves. returnTo must be a form path or a chat path (P5-57) on this server, so the page cannot be
 * used to redirect elsewhere.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../http/auth';
import { parse } from '../http/errors';
import type { FormAuthService } from '../services/form-auth';

/** printable ASCII only, no backslash, and no way out of the form path, plain or encoded */
function staysOnForm(returnTo: string): boolean {
  if (/[^\x21-\x7e]|\\/.test(returnTo)) return false;
  const segments = returnTo.split('?')[0].split('/');
  return !segments.some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

/** a Chat Trigger's address: production or test, any path after the workspace, ending in /chat */
const CHAT_PATH = /^\/webhook(-test)?\/[^/]+\/.+\/chat$/;
const FORM_PATH = /^\/form(-test|-waiting)?\//;

const codeBody = z.object({
  returnTo: z
    .string()
    .max(2048)
    .refine((value) => FORM_PATH.test(value) || CHAT_PATH.test(value.split('?')[0]))
    .refine(staysOnForm),
});

export function registerFormAuthRoutes(app: FastifyInstance, deps: { formAuth: FormAuthService }): void {
  const { formAuth } = deps;

  app.post('/form-auth/code', async (request) => {
    const auth = requireAuth(request);
    const { returnTo } = parse(codeBody, request.body);
    return { data: { code: await formAuth.issueCode(auth, returnTo) } };
  });
}
