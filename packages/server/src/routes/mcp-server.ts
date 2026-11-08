/**
 * The tenant MCP server endpoint (P5-04): `POST /mcp-server/:tenantSlug/http`, outside `/rest` (no
 * cookie, no CSRF: Bearer only). Served from an encapsulated plugin with a string body parser
 * (malformed JSON gives -32700, over the limit 413), `mcpHostAllowed` first on every method (else 403),
 * `mcpCorsHeaders` on every reply, GET and DELETE 405 with `Allow: POST`, HEAD 401 with
 * `WWW-Authenticate` and `resource_metadata`, OPTIONS CORS, `mcpRateLimit(config.mcp.rateLimit)`, and
 * 404 for everything while MCP access is off for the workspace. Registered by app.ts after `webhookPlugin`.
 */
import type { Readable } from 'node:stream';
import { MCP_ERRORS, mcpError } from '@workflow/workflow';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { mcpCorsHeaders, mcpHostAllowed, mcpRateLimit } from '../http/mcp-http';
import { authenticateMcpBearer } from '../services/mcp/auth';
import { handleMcpRequest } from '../services/mcp/server';
import { mcpAccessEnabled } from '../services/mcp/settings';
import { mcpResourceMetadataUrl, mcpServerUrl } from '../services/mcp/types';

export const MCP_SERVER_ROUTE = '/mcp-server/:tenantSlug/http';

export const MCP_ROUTE_TEXTS = {
  host: 'The Host header does not match the MCP base URL',
  notAvailable: 'MCP access is not available for this workspace',
  methodNotAllowed: 'Method not allowed: use POST',
  unauthorized: 'Unauthorized',
  tooLarge: 'Request body too large',
  parse: 'Parse error',
  rateLimited: 'Too many requests, please try again later',
  internal: 'Internal error',
} as const;

/** the 401 challenge: Bearer, with the RFC 9728 metadata URL of this server */
export function mcpServerChallenge(resource: string): string {
  return `Bearer realm="MCP Server", resource_metadata="${mcpResourceMetadataUrl(resource)}"`;
}

/** a 413 for the error handler; the stream is left open, so Node drains it and the answer reaches the client */
function tooLarge(): Error {
  return Object.assign(new Error(MCP_ROUTE_TEXTS.tooLarge), { statusCode: 413 });
}

/** the body as UTF-8 text, at most `limit` bytes (a larger declared length is refused before reading) */
function readBody(stream: Readable, declaredLength: unknown, limit: number): Promise<string> {
  if (Number(declaredLength) > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stop = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        stop();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      stop();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  reply.code(statusCode).headers({ ...mcpCorsHeaders(request.headers), ...headers });
  if (body === undefined) return reply.send();
  return reply.header('content-type', 'application/json').send(body);
}

export async function registerMcpServerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const { config } = ctx;
  await app.register(async (scope) => {
    // the body stays text until the server parses it, so a malformed body is a JSON-RPC parse error
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (request, payload, done) => {
      readBody(payload, request.headers['content-length'], config.bodyLimitBytes).then(
        (text) => done(null, text),
        (error: Error) => done(error, undefined),
      );
    });

    scope.setErrorHandler((error: FastifyError, request, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
        return send(
          reply,
          request,
          413,
          mcpError(null, MCP_ERRORS.INVALID_REQUEST, MCP_ROUTE_TEXTS.tooLarge),
        );
      }
      if (error.statusCode === 429) {
        return send(
          reply,
          request,
          429,
          mcpError(null, MCP_ERRORS.INVALID_REQUEST, MCP_ROUTE_TEXTS.rateLimited),
        );
      }
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return send(reply, request, 400, mcpError(null, MCP_ERRORS.PARSE, MCP_ROUTE_TEXTS.parse));
      }
      // never the message: it can hold a caller's data
      ctx.logger.warn({ error: error?.name }, 'MCP server route failed');
      return send(reply, request, 500, mcpError(null, MCP_ERRORS.INTERNAL, MCP_ROUTE_TEXTS.internal));
    });

    scope.route({
      method: ['POST', 'GET', 'HEAD', 'OPTIONS', 'DELETE'],
      url: MCP_SERVER_ROUTE,
      exposeHeadRoute: false,
      config: { rateLimit: mcpRateLimit(config.mcp.rateLimit) },
      handler: async (request, reply) => {
        // DNS rebinding: the Host must be the configured MCP host, before anything else
        if (!mcpHostAllowed(request, config)) {
          return send(reply, request, 403, { error: { code: 'forbidden', message: MCP_ROUTE_TEXTS.host } });
        }
        const { tenantSlug } = request.params as { tenantSlug: string };
        const tenant = await ctx.repos.tenants.getBySlug(tenantSlug);
        // off (or no such workspace): 404 for everything, so an OAuth client does not send a person to sign in
        if (!tenant || !mcpAccessEnabled(config, tenant)) {
          return send(reply, request, 404, {
            error: { code: 'not_found', message: MCP_ROUTE_TEXTS.notAvailable },
          });
        }
        const resource = mcpServerUrl(config, tenant.slug);
        switch (request.method) {
          case 'OPTIONS':
            return send(reply, request, 204);
          case 'HEAD':
            return send(reply, request, 401, undefined, { 'www-authenticate': mcpServerChallenge(resource) });
          case 'POST':
            break;
          default:
            return send(
              reply,
              request,
              405,
              mcpError(null, MCP_ERRORS.INVALID_REQUEST, MCP_ROUTE_TEXTS.methodNotAllowed),
              { allow: 'POST' },
            );
        }
        const caller = await authenticateMcpBearer(ctx, tenant.slug, request.headers.authorization, resource);
        if (!caller) {
          return send(
            reply,
            request,
            401,
            mcpError(null, MCP_ERRORS.INVALID_REQUEST, MCP_ROUTE_TEXTS.unauthorized),
            { 'www-authenticate': mcpServerChallenge(resource) },
          );
        }
        const answer = await handleMcpRequest(ctx, {
          caller,
          body: typeof request.body === 'string' ? request.body : '',
          headers: request.headers,
          resource,
          ip: request.ip,
        });
        return send(reply, request, answer.statusCode, answer.body, answer.headers);
      },
    });
  });
}
