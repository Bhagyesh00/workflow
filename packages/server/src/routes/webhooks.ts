/**
 * Webhook HTTP endpoints. Bodies are read raw (kept as `rawBody`) and parsed here; multipart
 * uploads become `WebhookRequest.files`.
 *
 * Responses are produced by tenant workflows but served from the platform origin, so they are
 * sandboxed: `Set-Cookie` is dropped and a `CSP: sandbox` header puts any HTML into an opaque
 * origin that cannot call the authenticated API.
 */
import multipart from '@fastify/multipart';
import type { WebhookRequest } from '@workflow/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { errorBody } from '../http/errors';
import { SESSION_COOKIE } from '../services/auth';
import { normalizePath } from '../services/webhook-paths';
import type { IncomingWebhook, WebhookReply } from '../services/webhooks';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SANDBOX_CSP =
  'sandbox allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-top-navigation-by-user-activation';
const DROPPED_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'content-length',
  'transfer-encoding',
  'connection',
]);

class BadBodyError extends Error {}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text, (key, value) => (BLOCKED_KEYS.has(key) ? undefined : value));
  } catch {
    throw new BadBodyError('The request body is not valid JSON');
  }
}

function parseForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (BLOCKED_KEYS.has(k)) continue;
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else out[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
  }
  return out;
}

function parseBody(contentType: string, raw: Buffer): unknown {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!raw.length) return {};
  if (type === 'application/json' || type.endsWith('+json')) return parseJson(raw.toString('utf8'));
  if (type === 'application/x-www-form-urlencoded') return parseForm(raw.toString('utf8'));
  if (type.startsWith('text/') || type.endsWith('/xml') || type.endsWith('+xml')) return raw.toString('utf8');
  // binary payloads are available as rawBody
  return {};
}

/** never hand the platform's session cookie to a tenant workflow */
function withoutSessionCookie(headers: FastifyRequest['headers']): WebhookRequest['headers'] {
  const out = { ...headers } as WebhookRequest['headers'];
  const cookie = headers.cookie;
  if (typeof cookie === 'string') {
    const kept = cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
    if (kept.length) out.cookie = kept.join('; ');
    else delete out.cookie;
  }
  return out;
}

async function toWebhookRequest(request: FastifyRequest): Promise<WebhookRequest> {
  const headers = withoutSessionCookie(request.headers);
  let body: unknown = {};
  let rawBody: Uint8Array | undefined;
  let files: WebhookRequest['files'];
  if (request.isMultipart()) {
    const fields: Record<string, unknown> = {};
    files = [];
    for await (const part of request.parts()) {
      if (BLOCKED_KEYS.has(part.fieldname)) continue;
      if (part.type === 'file') {
        files.push({
          fieldName: part.fieldname,
          fileName: part.filename,
          mimeType: part.mimetype,
          data: new Uint8Array(await part.toBuffer()),
        });
      } else {
        const existing = fields[part.fieldname];
        const value = part.value;
        fields[part.fieldname] =
          existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
    }
    body = fields;
  } else if (Buffer.isBuffer(request.body)) {
    rawBody = new Uint8Array(request.body);
    body = parseBody(String(request.headers['content-type'] ?? ''), request.body);
  }
  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
    if (!BLOCKED_KEYS.has(k)) query[k] = v;
  }
  return { method: request.method, headers, query, params: {}, body, rawBody, ip: request.ip, files };
}

function send(reply: FastifyReply, result: WebhookReply) {
  reply.status(result.statusCode);
  for (const [name, value] of Object.entries(result.headers)) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    try {
      reply.header(name, value);
    } catch {
      /* invalid header value from a workflow: skip it */
    }
  }
  reply.header('content-security-policy', SANDBOX_CSP);
  reply.header('x-content-type-options', 'nosniff');
  if (result.binary) {
    reply.header('content-type', result.binary.mimeType || 'application/octet-stream');
    if (result.binary.fileName) {
      reply.header(
        'content-disposition',
        `inline; filename="${result.binary.fileName.replace(/["\\\r\n]/g, '_')}"`,
      );
    }
    return reply.send(Buffer.from(result.binary.data));
  }
  if (result.body === undefined || result.body === null) return reply.send();
  if (typeof result.body === 'string') {
    if (!reply.hasHeader('content-type')) reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(result.body);
  }
  if (Buffer.isBuffer(result.body)) return reply.send(result.body);
  reply.header('content-type', 'application/json; charset=utf-8');
  return reply.send(JSON.stringify(result.body));
}

type Kind = 'production' | 'test';

export async function webhookPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  const bodyLimit = ctx.config.bodyLimitBytes;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (_req, body, done) => done(null, body));
  await app.register(multipart, {
    limits: { fileSize: bodyLimit, files: 50, fields: 500, fieldSize: 1024 * 1024 },
    throwFileSizeLimit: true,
  });

  const handle = (kind: Kind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { tenantSlug: string; '*'?: string };
    const path = normalizePath(params['*'] ?? '');
    if (request.method === 'OPTIONS') {
      return send(
        reply,
        await ctx.webhooks.handlePreflight(params.tenantSlug, path, request.headers.origin, kind === 'test'),
      );
    }
    let webhookRequest: WebhookRequest;
    try {
      webhookRequest = await toWebhookRequest(request);
    } catch (error) {
      if (error instanceof BadBodyError)
        return send(reply, { statusCode: 400, headers: {}, body: errorBody('bad_request', error.message) });
      throw error;
    }
    const incoming: IncomingWebhook = { method: request.method, path, request: webhookRequest };
    const result =
      kind === 'production'
        ? await ctx.webhooks.handleProduction(params.tenantSlug, incoming)
        : await ctx.webhooks.handleTest(params.tenantSlug, incoming);
    return send(reply, result);
  };

  const waiting = async (request: FastifyRequest, reply: FastifyReply) => {
    const { executionId } = request.params as { executionId: string };
    let webhookRequest: WebhookRequest;
    try {
      webhookRequest = await toWebhookRequest(request);
    } catch (error) {
      if (error instanceof BadBodyError)
        return send(reply, { statusCode: 400, headers: {}, body: errorBody('bad_request', error.message) });
      throw error;
    }
    const result = await ctx.webhooks.handleWaiting(executionId, {
      method: request.method,
      path: normalizePath((request.params as { '*'?: string })['*'] ?? ''),
      request: webhookRequest,
    });
    return send(reply, result);
  };

  app.all('/webhook/:tenantSlug/*', handle('production'));
  app.all('/webhook-test/:tenantSlug/*', handle('test'));
  app.all('/webhook-waiting/:executionId', waiting);
  app.all('/webhook-waiting/:executionId/*', waiting);
}
