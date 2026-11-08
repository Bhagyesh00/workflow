/**
 * An OpenAI-compatible chat completions fake on 127.0.0.1 (P5-09 C0, also for S5). It answers each
 * `POST /v1/chat/completions` (or `/chat/completions`) with the next step of the script: text, tool
 * calls or an HTTP error, as a plain JSON response or, when the request has `stream: true`, as
 * server-sent `chat.completion.chunk` events ending with `data: [DONE]`. Every request body is recorded
 * (parsed JSON), so a test can assert what a model was sent (tools offered, untrusted wrappers, no
 * secret). `GET /v1/models` lists one model. When the script runs out, the fake answers 500.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLlmToolCall {
  /** default `call_<step>_<index>` */
  id?: string;
  name: string;
  /** an object (sent as JSON) or a raw JSON string */
  arguments?: unknown;
}

export interface FakeLlmReply {
  /** assistant text; streamed in pieces of `chunkSize` characters */
  text?: string;
  toolCalls?: FakeLlmToolCall[];
  /** default `tool_calls` when there are tool calls, else `stop` */
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** answer with this HTTP status and an OpenAI error body instead (`error` is its message) */
  status?: number;
  error?: string;
  /** wait this long before answering (aborts, timeouts) */
  delayMs?: number;
  /** characters per streamed text delta, default 8 */
  chunkSize?: number;
  /** model name in the response, default `fake-model` */
  model?: string;
}

/** a scripted reply, or a function of the request body that returns one */
export type FakeLlmStep = FakeLlmReply | ((body: FakeLlmRequestBody) => FakeLlmReply);

/** the parts of an OpenAI request body the fake reads; the whole body is kept in `requests` */
export interface FakeLlmRequestBody {
  model?: string;
  stream?: boolean;
  messages?: Array<Record<string, unknown>>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
  [key: string]: unknown;
}

export interface FakeLlm {
  /** `http://127.0.0.1:<port>/v1`, the base URL an OpenAI-compatible credential takes */
  baseUrl: string;
  /** every chat completions request body, parsed, in order */
  requests: unknown[];
  close(): Promise<void>;
}

const MODEL = 'fake-model';
const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
const MODEL_PATHS = new Set(['/v1/models', '/models']);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {});
}

function toolCallsOf(reply: FakeLlmReply, step: number) {
  return (reply.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${step}_${index}`,
    type: 'function' as const,
    function: { name: call.name, arguments: argumentsText(call.arguments) },
  }));
}

function usageOf(reply: FakeLlmReply, body: FakeLlmRequestBody) {
  const prompt = reply.usage?.promptTokens ?? Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const completion = reply.usage?.completionTokens ?? Math.ceil((reply.text ?? '').length / 4);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function finishReasonOf(reply: FakeLlmReply): string {
  return reply.finishReason ?? (reply.toolCalls?.length ? 'tool_calls' : 'stop');
}

function sendPlain(res: ServerResponse, reply: FakeLlmReply, body: FakeLlmRequestBody, step: number): void {
  const toolCalls = toolCallsOf(reply, step);
  sendJson(res, 200, {
    id: `chatcmpl-fake-${step}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: reply.model ?? body.model ?? MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text ?? (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReasonOf(reply),
      },
    ],
    usage: usageOf(reply, body),
  });
}

function sendStream(res: ServerResponse, reply: FakeLlmReply, body: FakeLlmRequestBody, step: number): void {
  const id = `chatcmpl-fake-${step}`;
  const model = reply.model ?? body.model ?? MODEL;
  const created = Math.floor(Date.now() / 1000);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const event = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`,
    );

  event([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  const text = reply.text ?? '';
  const size = Math.max(1, reply.chunkSize ?? 8);
  for (let i = 0; i < text.length; i += size) {
    event([{ index: 0, delta: { content: text.slice(i, i + size) }, finish_reason: null }]);
  }
  toolCallsOf(reply, step).forEach((call, index) => {
    // the name and id first, then the arguments in two pieces, as real streams split them
    event([
      {
        index: 0,
        delta: {
          tool_calls: [
            { index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } },
          ],
        },
        finish_reason: null,
      },
    ]);
    const args = call.function.arguments;
    const half = Math.ceil(args.length / 2);
    for (const piece of [args.slice(0, half), args.slice(half)]) {
      if (piece)
        event([
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: piece } }] },
            finish_reason: null,
          },
        ]);
    }
  });
  event([{ index: 0, delta: {}, finish_reason: finishReasonOf(reply) }]);
  const options = body.stream_options as { include_usage?: boolean } | undefined;
  if (options?.include_usage) event([], { usage: usageOf(reply, body) });
  res.end('data: [DONE]\n\n');
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** starts the fake on a free port of 127.0.0.1; `close()` ends it and any open response */
export async function startFakeLlm(script: FakeLlmStep[]): Promise<FakeLlm> {
  const requests: unknown[] = [];
  let next = 0;

  const handle = async (request: IncomingMessage, res: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && MODEL_PATHS.has(path)) {
      sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'fake' }] });
      return;
    }
    if (request.method !== 'POST' || !CHAT_PATHS.has(path)) {
      sendJson(res, 404, {
        error: { message: `No route ${request.method} ${path}`, type: 'invalid_request_error' },
      });
      return;
    }
    const raw = await readBody(request);
    let body: FakeLlmRequestBody;
    try {
      body = JSON.parse(raw) as FakeLlmRequestBody;
    } catch {
      sendJson(res, 400, {
        error: { message: 'The request body is not JSON', type: 'invalid_request_error' },
      });
      return;
    }
    requests.push(body);
    const step = next++;
    const entry = script[step];
    if (!entry) {
      sendJson(res, 500, {
        error: {
          message: `fake LLM script has no step ${step + 1}`,
          type: 'server_error',
          code: 'server_error',
        },
      });
      return;
    }
    const reply = typeof entry === 'function' ? entry(body) : entry;
    if (reply.delayMs) await wait(reply.delayMs);
    if (res.destroyed) return;
    if (reply.status && reply.status >= 400) {
      sendJson(res, reply.status, {
        error: { message: reply.error ?? 'fake LLM error', type: 'server_error', code: String(reply.status) },
      });
      return;
    }
    if (body.stream === true) sendStream(res, reply, body, step);
    else sendPlain(res, reply, body, step);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: { message: String(error) } });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
