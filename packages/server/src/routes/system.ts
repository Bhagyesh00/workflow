/** Health, readiness, Prometheus metrics, and the editor SPA (or a status page when not built). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { ServerContext } from '../context';
import { errorBody } from '../http/errors';

/** paths the SPA fallback must never answer */
const RESERVED = [
  '/rest',
  '/api',
  '/webhook',
  '/webhook-test',
  '/webhook-waiting',
  '/form',
  '/form-test',
  '/form-waiting',
  '/chat-widget',
  '/healthz',
  '/metrics',
  // P5-03, P5-04, P5-14: MCP trigger, tenant MCP server, MCP OAuth server and its discovery documents
  '/mcp',
  '/mcp-test',
  '/mcp-server',
  '/mcp-oauth',
  '/.well-known',
  // P6-01, P6-02: SAML and OIDC sign-in, SCIM
  '/sso',
  '/scim',
];

/** RESERVED plus the MCP trigger endpoints of the config (`ENDPOINT_MCP`, `ENDPOINT_MCP_TEST`) */
export function reservedPaths(config: Pick<Config, 'mcp'>): string[] {
  return [...new Set([...RESERVED, `/${config.mcp.endpoint}`, `/${config.mcp.endpointTest}`])];
}

function isReserved(url: string, reserved: string[]): boolean {
  const pathname = url.split('?')[0];
  return reserved.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}

export function registerHealthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  app.get('/healthz/readiness', { logLevel: 'warn' }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    try {
      await ctx.database.db.execute(sql`select 1`);
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    if (ctx.redis) {
      try {
        await Promise.race([
          ctx.redis.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ]);
        checks.redis = 'ok';
      } catch {
        checks.redis = 'error';
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'error', checks });
  });

  app.get('/metrics', { logLevel: 'warn' }, async (request, reply) => {
    const token = ctx.config.metricsToken;
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return reply.status(401).send(errorBody('unauthorized', 'A metrics token is required'));
    }
    const body = await ctx.metrics.registry.metrics();
    return reply.header('content-type', ctx.metrics.registry.contentType).send(body);
  });
}

function statusPage(ctx: ServerContext): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const brand = esc(ctx.config.brand.name);
  const color = /^#[0-9a-fA-F]{3,8}$/.test(ctx.config.brand.primaryColor)
    ? ctx.config.brand.primaryColor
    : '#4f46e5';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} server</title>
<style>
:root{color-scheme:light dark;--accent:${color}}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:640px;margin:10vh auto;padding:0 16px}
h1{font-size:1.6rem;margin:0 0 .25rem}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:#16a34a;margin-right:.4rem}
a{color:var(--accent)}
code{font-size:.9em}
li{margin:.3rem 0}
</style></head>
<body><main>
<h1>${brand}</h1>
<p><span class="dot"></span>The API server is running (${esc(ctx.config.executionsMode)} mode).</p>
<p>The editor is not built yet. Run <code>pnpm --filter @workflow/editor build</code> and reload, or set <code>EDITOR_DIST</code>.</p>
<ul>
<li><a href="/api/v1/docs">Public API reference</a> (<a href="/api/v1/openapi.json">OpenAPI 3.1</a>)</li>
<li><a href="/healthz/readiness">Readiness</a></li>
<li><a href="/rest/settings">Instance settings</a></li>
</ul>
</main></body></html>`;
}

export async function registerEditor(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const dist = ctx.config.editorDist;
  const index = path.join(dist, 'index.html');
  const hasEditor = existsSync(index);
  if (hasEditor) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      wildcard: false,
      index: false,
      maxAge: '1h',
      setHeaders(reply, filePath) {
        // hashed build assets never change
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  const reserved = reservedPaths(ctx.config);
  const spa = async (request: FastifyRequest, reply: FastifyReply) => {
    if ((request.method === 'GET' || request.method === 'HEAD') && !isReserved(request.url, reserved)) {
      const accept = String(request.headers.accept ?? '');
      if (!accept || accept.includes('text/html') || accept.includes('*/*')) {
        if (hasEditor) return reply.header('cache-control', 'no-cache').sendFile('index.html');
        return reply.header('content-type', 'text/html; charset=utf-8').send(statusPage(ctx));
      }
    }
    return reply
      .status(404)
      .send(errorBody('not_found', `Route ${request.method} ${request.url.split('?')[0]} not found`));
  };
  app.setNotFoundHandler(spa);
}
