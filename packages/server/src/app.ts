/** Fastify application: REST API, public API, webhooks, push, health/metrics and the editor. */
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { ServerContext } from './context';
import { checkCsrf, checkTenant, loadSession, TENANT_HEADER } from './http/auth';
import { handleError } from './http/errors';
import { registerAiRoutes } from './routes/ai';
import { registerAiSessionRoutes } from './routes/ai-sessions';
import { registerAnnotationTagRoutes } from './routes/annotation-tags';
import { registerApiKeyRoutes } from './routes/api-keys';
import { registerAssistantRoutes } from './routes/assistant';
import { registerAssistantConfirmRoutes } from './routes/assistant-confirm';
import { registerAssistantDraftRoutes } from './routes/assistant-drafts';
import { registerAssistantMcpRoutes } from './routes/assistant-mcp';
import { registerAssistantSettingsRoutes } from './routes/assistant-settings';
import { registerAuthRoutes } from './routes/auth';
import { registerChatWidgetRoutes } from './routes/chat-widget';
import { registerCollaborationRoutes } from './routes/collaboration';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDataTableRoutes } from './routes/data-tables';
import { registerDependencyRoutes } from './routes/dependencies';
import { registerEvaluationRoutes } from './routes/evaluations';
import { registerExecutionBulkRoutes } from './routes/execution-bulk';
import { registerExecutionRoutes } from './routes/executions';
import { registerFavoriteRoutes } from './routes/favorites';
import { registerFolderRoutes } from './routes/folders';
import { registerFormAuthRoutes } from './routes/form-auth';
import { registerInsightsRoutes } from './routes/insights';
import { registerJwksRoutes } from './routes/jwks';
import { registerLdapRoutes } from './routes/ldap';
import { registerLogStreamingRoutes } from './routes/log-streaming';
import { registerMcpConsentRoutes } from './routes/mcp-consent';
import { mcpOAuthPlugin } from './routes/mcp-oauth';
import { registerMcpOAuthClientRoutes } from './routes/mcp-oauth-clients';
import { registerMcpServerRoutes } from './routes/mcp-server';
import { registerMcpSettingsRoutes } from './routes/mcp-settings';
import { registerMemberRoutes } from './routes/members';
import { registerMfaRoutes } from './routes/mfa';
import { registerOtelRoutes } from './routes/otel';
import { registerPasswordRoutes } from './routes/password';
import { registerProjectRoutes } from './routes/projects';
import { publicApiPlugin } from './routes/public-api';
import { registerPushRoutes } from './routes/push';
import { registerRateLimitSettingsRoutes } from './routes/rate-limit-settings';
import { registerResourceRoutes } from './routes/resources';
import { registerRoleRoutes } from './routes/roles';
import { scimPlugin } from './routes/scim';
import { registerScimSettingsRoutes } from './routes/scim-settings';
import { registerSecretConnectionRoutes } from './routes/secret-connections';
import { registerSecuritySettingsRoutes } from './routes/security-settings';
import { registerSettingsRoutes } from './routes/settings';
import { registerSharingRoutes } from './routes/sharing';
import { registerSourceControlRoutes } from './routes/source-control';
import { registerSourceControlSyncRoutes } from './routes/source-control-sync';
import { registerOidcRestRoutes } from './routes/sso-oidc';
import { registerProvisioningRoutes } from './routes/sso-provisioning';
import { ssoPlugin } from './routes/sso-public';
import { registerSamlRestRoutes } from './routes/sso-saml';
import { registerSsoSettingsRoutes } from './routes/sso-settings';
import { registerEditor, registerHealthRoutes } from './routes/system';
import { registerTransferRoutes } from './routes/transfer';
import { registerTypePolicyRoutes } from './routes/type-policies';
import { registerProjectTypePolicyRoutes } from './routes/type-policies-project';
import { webhookPlugin } from './routes/webhooks';
import { registerWorkflowReviewRoutes } from './routes/workflow-reviews';
import { registerWorkflowRoutes } from './routes/workflows';

/** JSON bodies: empty bodies are allowed, `__proto__` keys are dropped */
function parseJsonBody(_request: unknown, body: string, done: (err: Error | null, value?: unknown) => void) {
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

export async function buildApp(ctx: ServerContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const baseOrigin = new URL(config.baseUrl).origin;
  const app = Fastify({
    loggerInstance: ctx.logger as unknown as FastifyBaseLogger,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
    routerOptions: { maxParamLength: 1024 },
  });

  app.setErrorHandler(handleError);
  // P6-71 (S5 C0): every answered request reaches the API metrics with its route pattern (never the raw URL);
  // a metrics failure never touches the answer
  app.addHook('onResponse', async (request, reply) => {
    try {
      ctx.metrics.observeApi(
        request.method,
        request.routeOptions.url ?? 'unknown',
        reply.statusCode,
        reply.elapsedTime,
      );
    } catch {
      // ignored: the answer is already sent
    }
  });
  app.decorateRequest('auth', null);
  // P6-03: `requireScope` reads `request.server.access`; decorated on the root, so every plugin sees it
  app.decorate('access', ctx.access);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: config.bodyLimitBytes },
    parseJsonBody,
  );

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    ...(ctx.redis && config.executionsMode === 'queue'
      ? { redis: ctx.redis, nameSpace: `${config.queue.prefix}:rl:` }
      : {}),
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        // P3-08 binary previews: audio / video and the browser PDF viewer from typed Blobs
        mediaSrc: ["'self'", 'blob:', 'data:'],
        frameSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // the OAuth2 'Connect account' popup must keep reporting back to the editor that opened it
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: config.cookieSecure ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  // webhooks: raw bodies, sandboxed responses
  await app.register(webhookPlugin, { ctx });
  // P6 S2: SAML and OIDC sign-in (P6-09, P6-10), SCIM (P6-02) and the JWE keys (P6-16), outside /rest (no
  // session, no CSRF: the signed IdP message, the signed state, the SCIM token is the proof; the keys are public)
  await app.register(ssoPlugin, { prefix: '/sso', ctx });
  await app.register(scimPlugin, { prefix: '/scim/v2', ctx });
  registerJwksRoutes(app, ctx);

  registerHealthRoutes(app, ctx);
  // P5-56: the chat widget's script and styles, outside /rest (no session, no CSRF)
  await registerChatWidgetRoutes(app, ctx);
  // P5-04, P5-14: tenant MCP server and MCP OAuth server, outside /rest (Bearer only: no session, no CSRF, no cookie)
  await registerMcpServerRoutes(app, ctx);
  await app.register(mcpOAuthPlugin, { ctx });

  // editor API: session cookie + CSRF checks
  await app.register(
    async (rest) => {
      rest.addHook('onRequest', async (request, reply) => {
        // an editor served from another allowed origin (CORS_ORIGINS, e.g. a dev server)
        const origin = request.headers.origin;
        if (origin && origin !== baseOrigin && config.allowedOrigins.includes(origin)) {
          reply
            .header('access-control-allow-origin', origin)
            .header('access-control-allow-credentials', 'true')
            .header('vary', 'Origin');
        }
        if (request.method === 'OPTIONS') return;
        checkCsrf(request, config);
        await loadSession(request, reply, config, ctx.repos);
        checkTenant(request);
      });
      rest.options('/*', async (_request, reply) =>
        reply
          .status(204)
          .header('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
          // P6-81: `push-ref` names the editor tab (the collaboration client id) on presence and write access calls
          .header('access-control-allow-headers', `content-type, ${TENANT_HEADER}, push-ref`)
          .header('access-control-max-age', '600')
          .send(),
      );
      registerAuthRoutes(rest, ctx);
      registerSettingsRoutes(rest, ctx);
      registerWorkflowRoutes(rest, ctx);
      registerExecutionRoutes(rest, ctx);
      registerCredentialRoutes(rest, ctx);
      registerResourceRoutes(rest, ctx);
      registerPushRoutes(rest, ctx);
      // Phase 3 (filled by L8, L9, L14)
      registerFolderRoutes(rest, ctx);
      registerFavoriteRoutes(rest, ctx);
      registerAnnotationTagRoutes(rest, ctx);
      registerWorkflowReviewRoutes(rest, ctx);
      // Phase 4 (filled by L4, L9, L2)
      registerDataTableRoutes(rest, ctx);
      registerSecretConnectionRoutes(rest, ctx);
      registerFormAuthRoutes(rest, ctx);
      // Phase 5: evaluation test runs (P5-02)
      registerEvaluationRoutes(rest, ctx);
      // Phase 5 S4: AI workflow builder (P5-09, P5-66), MCP settings, OAuth clients and consent (P5-04, P5-14, P5-15)
      registerAiRoutes(rest, ctx);
      registerAiSessionRoutes(rest, ctx);
      registerMcpSettingsRoutes(rest, ctx);
      registerMcpOAuthClientRoutes(rest, ctx);
      registerMcpConsentRoutes(rest, ctx);
      // Phase 5 S5: the Assistant (P5-67): threads, chat and events, approval cards, drafts, settings, MCP connections
      registerAssistantRoutes(rest, ctx);
      registerAssistantConfirmRoutes(rest, ctx);
      registerAssistantDraftRoutes(rest, ctx);
      registerAssistantSettingsRoutes(rest, ctx);
      registerAssistantMcpRoutes(rest, ctx);
      // Phase 6 S1: projects (P6-03), sharing and transfers (P6-29, P6-30), roles (P6-32), security settings (P6-33)
      registerProjectRoutes(rest, ctx);
      registerSharingRoutes(rest, ctx);
      registerTransferRoutes(rest, ctx);
      registerRoleRoutes(rest, ctx);
      registerSecuritySettingsRoutes(rest, ctx);
      // Phase 6 S2: members and API keys (moved from resources.ts; P6-20, P6-21), MFA (P6-18), password
      // (P6-19), SSO settings, SAML, OIDC, provisioning (P6-01, P6-09, P6-10, P6-11), LDAP (P6-12), SCIM (P6-02)
      registerMemberRoutes(rest, ctx);
      registerApiKeyRoutes(rest, ctx);
      registerMfaRoutes(rest, ctx);
      registerPasswordRoutes(rest, ctx);
      registerSsoSettingsRoutes(rest, ctx);
      registerSamlRestRoutes(rest, ctx);
      registerOidcRestRoutes(rest, ctx);
      registerProvisioningRoutes(rest, ctx);
      registerLdapRoutes(rest, ctx);
      registerScimSettingsRoutes(rest, ctx);
      // Phase 6 S3: node and credential type policies (P6-49, P6-51), insights (P6-05), collaboration (P6-81),
      // bulk run actions (P6-85), dependencies (P6-86), public API rate limit settings (P6-83)
      registerTypePolicyRoutes(rest, ctx);
      registerProjectTypePolicyRoutes(rest, ctx);
      registerInsightsRoutes(rest, ctx);
      registerCollaborationRoutes(rest, ctx);
      registerExecutionBulkRoutes(rest, ctx);
      registerDependencyRoutes(rest, ctx);
      registerRateLimitSettingsRoutes(rest, ctx);
      // P6 S4: source control (L2 connection, L4 status, push and pull)
      registerSourceControlRoutes(rest, ctx);
      registerSourceControlSyncRoutes(rest, ctx);
      // P6 S5: log streaming destinations (L3) and OpenTelemetry settings (L11)
      registerLogStreamingRoutes(rest, ctx);
      registerOtelRoutes(rest, ctx);
    },
    { prefix: '/rest' },
  );

  // P6-21: PUBLIC_API_DISABLED turns the whole public API off (every /api/v1 path answers 404, never the SPA)
  if (!config.publicApiDisabled) await app.register(publicApiPlugin, { prefix: '/api/v1', ctx });
  await registerEditor(app, ctx);
  return app;
}
