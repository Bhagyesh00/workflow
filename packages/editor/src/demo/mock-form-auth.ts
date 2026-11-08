/** Demo route that issues the one-time sign-in code: session required, form or chat paths only, as the server. */
import { newId } from '../lib/ids';
import { isFormReturnPath } from '../pages/auth/FormSignInPage';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

export function registerFormAuthRoutes(backend: MockBackend): void {
  backend.on('POST', '/form-auth/code', ({ body }) => {
    backend.auth();
    const { returnTo } = (body ?? {}) as { returnTo?: unknown };
    if (typeof returnTo !== 'string' || returnTo.length > 2048 || !isFormReturnPath(returnTo)) {
      throw new HttpError(400, 'bad_request', 'returnTo must be a form or chat path on this server');
    }
    return { code: newId() };
  });
}
