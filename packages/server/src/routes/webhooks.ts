/**
 * Webhook HTTP endpoints. Bodies are read raw (kept as `rawBody`) and parsed here, only once the
 * service has found the webhook, so that every unreadable body (too large, malformed) is answered
 * with the node's CORS headers; multipart uploads become `WebhookRequest.files`.
 *
 * Responses are produced by tenant workflows but served from the platform origin, so they are
 * sandboxed: `Set-Cookie` is dropped and a `CSP: sandbox` header puts any HTML into an opaque
 * origin that cannot call the authenticated API.
 */
import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import type { WebhookRequest } from '@workflow/workflow';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { errorBody } from '../http/errors';
import { SESSION_COOKIE } from '../services/auth';
import { normalizePath } from '../services/webhook-paths';
import {
  type IncomingWebhook,
  WebhookBodyError,
  type WebhookKind,
  type WebhookReply,
} from '../services/webhooks';

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

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text, (key, value) => (BLOCKED_KEYS.has(key) ? undefined : value));
  } catch {
    throw new WebhookBodyError(400, 'bad_request', 'The request body is not valid JSON');
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

const tooLarge = (bodyLimit: number) =>
  new WebhookBodyError(413, 'payload_too_large', `The request body is larger than ${bodyLimit} bytes`);

/** the multipart limits (file size, file and field counts) reject with their own 413 errors */
function asBodyError(error: unknown): never {
  if (!(error instanceof WebhookBodyError) && (error as { statusCode?: number }).statusCode === 413)
    throw new WebhookBodyError(413, 'payload_too_large', (error as Error).message);
  throw error;
}

/**
 * Reads a body stream up to `bodyLimit` bytes. The stream is not destroyed when the limit is hit,
 * so the connection stays open for the 413 answer.
 */
async function readBody(stream: Readable, declaredLength: unknown, bodyLimit: number): Promise<Buffer> {
  if (Number(declaredLength) > bodyLimit) throw tooLarge(bodyLimit);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > bodyLimit) throw tooLarge(bodyLimit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function toWebhookRequest(request: FastifyRequest, bodyLimit: number): Promise<WebhookRequest> {
  const headers = withoutSessionCookie(request.headers);
  let body: unknown = {};
  let rawBody: Uint8Array | undefined;
  let files: WebhookRequest['files'];
  if (request.isMultipart()) {
    const fields: Record<string, unknown> = {};
    files = [];
    // the multipart limits are per part: one budget across all parts keeps a request within the body limit
    let total = 0;
    const consume = (bytes: number) => {
      total += bytes;
      if (total > bodyLimit) throw tooLarge(bodyLimit);
    };
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file as AsyncIterable<Buffer>) {
          consume(chunk.length);
          chunks.push(chunk);
        }
        if (part.file.truncated) throw tooLarge(bodyLimit);
        if (BLOCKED_KEYS.has(part.fieldname)) continue;
        files.push({
          fieldName: part.fieldname,
          fileName: part.filename,
          mimeType: part.mimetype,
          data: new Uint8Array(Buffer.concat(chunks)),
        });
      } else {
        const value = part.value;
        consume(Buffer.byteLength(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')));
        if (BLOCKED_KEYS.has(part.fieldname)) continue;
        const existing = fields[part.fieldname];
        fields[part.fieldname] =
          existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
    }
    body = fields;
  } else if (request.body instanceof Readable) {
    const raw = await readBody(request.body, request.headers['content-length'], bodyLimit);
    rawBody = new Uint8Array(raw);
    body = parseBody(String(request.headers['content-type'] ?? ''), raw);
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
  if (result.stream) return reply.send(result.stream);
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

type Mode = 'production' | 'test';

export async function webhookPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  const bodyLimit = ctx.config.bodyLimitBytes;
  app.removeAllContentTypeParsers();
  // the body stays a stream until toWebhookRequest reads it within bodyLimit
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
  // per-part limits; toWebhookRequest also holds all parts of one request to bodyLimit bytes in total
  const files = 50;
  const fields = 500;
  await app.register(multipart, {
    limits: {
      fileSize: bodyLimit,
      files,
      fields,
      parts: files + fields,
      fieldSize: Math.min(bodyLimit, 1024 * 1024),
    },
    throwFileSizeLimit: true,
  });

  /** the body is read only when the service has found the webhook: unknown paths are never parsed */
  const incomingOf = (request: FastifyRequest, path: string): IncomingWebhook => ({
    method: request.method,
    path,
    headers: withoutSessionCookie(request.headers),
    read: () => toWebhookRequest(request, bodyLimit).catch(asBodyError),
  });

  const respond = async (reply: FastifyReply, result: () => Promise<WebhookReply>) => {
    try {
      return send(reply, await result());
    } catch (error) {
      // production and test webhooks answer unreadable bodies themselves (with the node's CORS headers)
      if (error instanceof WebhookBodyError) {
        const body = errorBody(error.code, error.message);
        return send(reply, { statusCode: error.statusCode, headers: {}, body });
      }
      throw error;
    }
  };

  const handle = (mode: Mode, kind: WebhookKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { tenantSlug: string; '*'?: string };
    const path = normalizePath(params['*'] ?? '');
    if (request.method === 'OPTIONS') {
      return send(
        reply,
        await ctx.webhooks.handlePreflight(params.tenantSlug, path, request.headers, mode === 'test'),
      );
    }
    const incoming = incomingOf(request, path);
    return respond(reply, () =>
      mode === 'production'
        ? ctx.webhooks.handleProduction(params.tenantSlug, incoming, kind)
        : ctx.webhooks.handleTest(params.tenantSlug, incoming, kind),
    );
  };

  const waiting = (kind: WebhookKind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { executionId } = request.params as { executionId: string };
    const path = normalizePath((request.params as { '*'?: string })['*'] ?? '');
    return respond(reply, () => ctx.webhooks.handleWaiting(executionId, incomingOf(request, path), kind));
  };

  app.all('/webhook/:tenantSlug/*', handle('production', 'webhook'));
  app.all('/webhook-test/:tenantSlug/*', handle('test', 'webhook'));
  app.all('/webhook-waiting/:executionId', waiting('webhook'));
  app.all('/webhook-waiting/:executionId/*', waiting('webhook'));
  app.all('/form/:tenantSlug/*', handle('production', 'form'));
  app.all('/form-test/:tenantSlug/*', handle('test', 'form'));
  app.all('/form-waiting/:executionId', waiting('form'));
  app.all('/form-waiting/:executionId/*', waiting('form'));
}
