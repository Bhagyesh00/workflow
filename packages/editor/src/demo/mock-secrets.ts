/** Demo routes for external secret connections. Stubs: L10 (P4-07) writes them. */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

/** every route of `secretsApi`, in match order */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/secret-providers/types'],
  ['GET', '/secret-providers/types/:type'],
  ['GET', '/secret-providers/completions/secrets'],
  ['GET', '/secret-providers/connections'],
  ['POST', '/secret-providers/connections'],
  ['GET', '/secret-providers/connections/:providerKey'],
  ['PATCH', '/secret-providers/connections/:providerKey'],
  ['DELETE', '/secret-providers/connections/:providerKey'],
  ['POST', '/secret-providers/connections/:providerKey/test'],
  ['POST', '/secret-providers/connections/:providerKey/reload'],
];

export function registerSecretRoutes(backend: MockBackend): void {
  for (const [method, path] of ROUTES) backend.on(method, path, () => notImplemented('L10'));
}
