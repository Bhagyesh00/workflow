/**
 * /rest/form-auth (P4-16). FormSignInPage calls it with the session; any member may ask, and only for
 * themselves. returnTo must be a form path, a chat path (P5-57) or a webhook path (P6-87) on this server, so
 * the page cannot be used to redirect elsewhere; the service takes a webhook path only for a Webhook node with
 * workspace sign-in.
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
/** a webhook's address: production or test, the workspace, then a path (the service checks the node) */
const WEBHOOK_PATH = /^\/webhook(-test)?\/[^/]+\/.+/;
const FORM_PATH = /^\/form(-test|-waiting)?\//;

const codeBody = z.object({
  returnTo: z
    .string()
    .max(2048)
    .refine((value) => {
      const path = value.split('?')[0];
      return FORM_PATH.test(value) || CHAT_PATH.test(path) || WEBHOOK_PATH.test(path);
    })
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
