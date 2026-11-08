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
import { registerAssistantRoutes } from './routes/assistant';
import { registerAssistantConfirmRoutes } from './routes/assistant-confirm';
import { registerAssistantDraftRoutes } from './routes/assistant-drafts';
import { registerAssistantMcpRoutes } from './routes/assistant-mcp';
import { registerAssistantSettingsRoutes } from './routes/assistant-settings';
import { registerAuthRoutes } from './routes/auth';
import { registerChatWidgetRoutes } from './routes/chat-widget';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDataTableRoutes } from './routes/data-tables';
import { registerEvaluationRoutes } from './routes/evaluations';
import { registerExecutionRoutes } from './routes/executions';
import { registerFavoriteRoutes } from './routes/favorites';
import { registerFolderRoutes } from './routes/folders';
import { registerFormAuthRoutes } from './routes/form-auth';
import { registerMcpConsentRoutes } from './routes/mcp-consent';
import { mcpOAuthPlugin } from './routes/mcp-oauth';
import { registerMcpOAuthClientRoutes } from './routes/mcp-oauth-clients';
import { registerMcpServerRoutes } from './routes/mcp-server';
import { registerMcpSettingsRoutes } from './routes/mcp-settings';
import { publicApiPlugin } from './routes/public-api';
import { registerPushRoutes } from './routes/push';
import { registerResourceRoutes } from './routes/resources';
import { registerSecretConnectionRoutes } from './routes/secret-connections';
import { registerSettingsRoutes } from './routes/settings';
import { registerEditor, registerHealthRoutes } from './routes/system';
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
  app.decorateRequest('auth', null);
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
          .header('access-control-allow-headers', `content-type, ${TENANT_HEADER}`)
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
    },
    { prefix: '/rest' },
  );

  await app.register(publicApiPlugin, { prefix: '/api/v1', ctx });
  await registerEditor(app, ctx);
  return app;
}
