/**
 * The public SSO routes under `/sso` (P6-01, P6-09, P6-10; C0-final). Registered by app.ts beside
 * `webhookPlugin`, outside the `/rest` session and CSRF hook: the identity provider and the browser reach
 * them before any session exists, and the signed SAML message or the signed OIDC state is the proof. The
 * plugin parses `application/x-www-form-urlencoded` bodies (the SAML POST binding) itself, 1 MB at most, as
 * routes/webhooks.ts `parseForm`; JSON keeps the app's parser. SAML (L7) and OIDC (L8) fill their routes in
 * routes/sso-saml.ts and routes/sso-oidc.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { registerOidcPublicRoutes } from './sso-oidc';
import { registerSamlPublicRoutes } from './sso-saml';
import { parseForm } from './webhooks';

/** a SAML response with its signature and certificates fits well below this */
export const SSO_FORM_BODY_LIMIT = 1_048_576;

export async function ssoPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: SSO_FORM_BODY_LIMIT },
    (_request, body, done) => done(null, parseForm(String(body))),
  );
  registerSamlPublicRoutes(app, ctx);
  registerOidcPublicRoutes(app, ctx);
}
