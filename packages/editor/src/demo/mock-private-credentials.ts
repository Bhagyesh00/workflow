/**
 * P6-15: the demo's private credentials: a user connects their own account to a shared credential and
 * clears their own connection. The connections live in `MockBackend.privateConnections` (credential id to
 * user ids). As the shared OAuth connect of the demo, the provider sign-in needs a running server, so
 * authorize answers 400 after the server's own checks; tests and seeds connect a user by writing the map.
 */
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

/** the server's text for a per user connect of a fixed credential */
export const NOT_PRIVATE_MESSAGE = 'This credential is not private: connect it from the credential instead';

export function registerPrivateCredentialRoutes(backend: MockBackend): void {
  const find = (id: string) => {
    const { tenant } = backend.auth();
    return backend.credentials.find((c) => c.id === id && c.tenantId === tenant.id);
  };

  // `credential:connect` on the credential, as the server's gate; another workspace's id is 404
  backend.on('POST', '/credentials/:id/authorize', ({ params }) => {
    const c = find(params[0]);
    if (!c) {
      backend.requireScope('credential:connect');
      throw new HttpError(404, 'not_found', 'Credential not found');
    }
    backend.requireScope('credential:connect', { scopes: backend.rowScopes(c) });
    if (!c.isResolvable) throw new HttpError(400, 'bad_request', NOT_PRIVATE_MESSAGE);
    throw new HttpError(
      400,
      'not_available',
      'Connecting your own account needs a running server; it is not available in this demo.',
    );
  });

  // session only, as the server: a user who lost access may still clear their own connection
  backend.on('DELETE', '/credentials/:id/my-connection', ({ params }) => {
    const { user } = backend.auth();
    const c = find(params[0]);
    if (!c) throw new HttpError(404, 'not_found', 'Credential not found');
    backend.privateConnections.get(c.id)?.delete(user.id);
    return { ok: true };
  });
}
