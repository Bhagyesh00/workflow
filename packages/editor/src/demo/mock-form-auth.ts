/** Demo route that issues the one-time form sign-in code: session required, form paths only, as the server. */
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

export function registerFormAuthRoutes(backend: MockBackend): void {
  backend.on('POST', '/form-auth/code', ({ body }) => {
    backend.auth();
    const { returnTo } = (body ?? {}) as { returnTo?: string };
    if (!returnTo || !/^\/form(-test|-waiting)?\/./.test(returnTo) || returnTo.includes('..')) {
      throw new HttpError(400, 'bad_request', 'returnTo must be a form path on this server');
    }
    return { code: newId() };
  });
}
