/**
 * SCIM 2.0 (P6-02, L13), under `/scim/v2` outside the `/rest` session and CSRF hook: the identity
 * provider's SCIM client calls it with the workspace's SCIM token (`Authorization: Bearer`), and the token
 * alone names the workspace. GET and POST `/Users`, GET, PUT, PATCH and DELETE `/Users/:id`, GET
 * `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`. Bodies are `application/scim+json` (own parser,
 * 1 MB).
 * C0 registered the 9 routes with their final paths; the handlers throw until L13 (stub (L13)), which adds
 * the token check, the rate limit and the SCIM error shape.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';

const SCIM_BODY_LIMIT = 1_048_576;

/** a SCIM body; `__proto__` keys are dropped, as the JSON parser of the app does */
function parseScimJson(_request: unknown, body: string, done: (err: Error | null, value?: unknown) => void) {
  if (!body?.trim()) return done(null, undefined);
  try {
    done(
      null,
      JSON.parse(body, (key, value) => (key === '__proto__' ? undefined : value)),
    );
  } catch {
    const error = new Error('The request body is not valid JSON') as Error & { statusCode: number };
    error.statusCode = 400;
    done(error);
  }
}

export async function scimPlugin(app: FastifyInstance, _opts: { ctx: ServerContext }): Promise<void> {
  app.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string', bodyLimit: SCIM_BODY_LIMIT },
    parseScimJson,
  );

  // public by session: the SCIM token is the proof (L13)
  app.get('/Users', async () => {
    throw new Error('not implemented (L13)');
  });
  app.post('/Users', async () => {
    throw new Error('not implemented (L13)');
  });
  app.get('/Users/:id', async () => {
    throw new Error('not implemented (L13)');
  });
  app.put('/Users/:id', async () => {
    throw new Error('not implemented (L13)');
  });
  app.patch('/Users/:id', async () => {
    throw new Error('not implemented (L13)');
  });
  app.delete('/Users/:id', async () => {
    throw new Error('not implemented (L13)');
  });
  app.get('/ServiceProviderConfig', async () => {
    throw new Error('not implemented (L13)');
  });
  app.get('/ResourceTypes', async () => {
    throw new Error('not implemented (L13)');
  });
  app.get('/Schemas', async () => {
    throw new Error('not implemented (L13)');
  });
}
