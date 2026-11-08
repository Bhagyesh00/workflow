/**
 * Who may use a Chat Trigger (P5-57), shared by its setup GET (the hosted page) and its POST (messages):
 * the availability rules (public off, non-public chats only for a test run with its test token), Basic
 * auth with a signed `x-auth-token` for the sandboxed page that cannot send the login, and workspace
 * sign-in (`n8nUserAuth`) through the shared user-auth helper. Tokens, codes and passwords are never put
 * in an error, a URL or a log line.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { checkUserAuth } from '@workflow/nodes-base/utils/user-auth';
import {
  type AiChatMessage,
  type AiMemory,
  CHAT_AUTH_HEADER,
  CHAT_TEST_HEADER,
  CHAT_TOKEN_KINDS,
  type ChatTokenKind,
  type DataObject,
  type FormUser,
  type WebhookContext,
  type WebhookResponseData,
} from '@workflow/workflow';
import { chatResponse } from './chat-setup';

/** the Basic token lives as long as a form's */
const BASIC_TOKEN_TTL_SECONDS = 60 * 60;

export const CHAT_AUTH_TEXTS = {
  required: 'Authorization is required!',
  wrong: 'Authorization data is wrong!',
  missing: 'No authentication data defined on node!',
} as const;

const USER_AUTH_TEXTS = {
  noSignIn: "This chat needs a workspace sign-in, and sign-in isn't available here.",
  noPermission: "You don't have permission to open this chat.",
  signInAgain: 'Your chat sign-in has ended. Open the chat again to sign in.',
};

export function safeEqual(a: string, b: string): boolean {
  // hash first so lengths match and the comparison time does not depend on the secret
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function headerValue(ctx: WebhookContext, name: string): string | undefined {
  const v = ctx.getHeaderData()[name];
  return Array.isArray(v) ? v[0] : v;
}

/** a signed token in `header` that holds `kind` and names this tenant, workflow and Chat Trigger */
function holdsToken(ctx: WebhookContext, header: string, kind: ChatTokenKind): boolean {
  const token = headerValue(ctx, header);
  if (!token) return false;
  const payload = ctx.verifyFormToken(token);
  return (
    payload !== null &&
    payload.kind === kind &&
    payload.tenantId === ctx.getTenantId() &&
    payload.workflowId === (ctx.getWorkflow().id ?? '') &&
    payload.node === ctx.getNode().name
  );
}

export interface ChatAccess {
  /** set when the caller is refused: send it instead of answering */
  refusal?: WebhookResponseData;
  /** the signed-in user, for Workspace sign-in; the node adds it to the item when Include User is on */
  user?: FormUser;
  /** the token the hosted page sends back as `x-auth-token` */
  authToken?: string;
  /** headers for the page reply: the auth cookie of a sign-in */
  headers: Record<string, string>;
}

const allow = (extra: Partial<ChatAccess> = {}): ChatAccess => ({ headers: {}, ...extra });
const refuse = (refusal: WebhookResponseData): ChatAccess => ({ headers: {}, refusal });

const NOT_AVAILABLE = 'This chat is not available';

/** ties a token to this login: a changed password ends the tokens issued under the old one */
const credentialDigest = (user: string, password: string) =>
  createHash('sha256').update(`${user}\0${password}`).digest('base64url');

/**
 * Basic auth. A browser shows the login on the page's GET; the sandboxed page cannot, so its POST shows
 * the token the GET handed it (`allowToken`). No credentials at all is 401, wrong ones 403.
 */
async function basicAccess(
  ctx: WebhookContext,
  corsOrigin: string | undefined,
  allowToken: boolean,
): Promise<ChatAccess> {
  const respond = (status: number, message: string) => refuse(chatResponse(status, { message }, corsOrigin));
  if (!ctx.getNode().credentials?.httpBasicAuth) return respond(500, CHAT_AUTH_TEXTS.missing);
  let user: string;
  let password: string;
  try {
    const creds = await ctx.getCredentials<{ user?: unknown; password?: unknown }>('httpBasicAuth');
    user = String(creds.user ?? '');
    password = String(creds.password ?? '');
  } catch {
    return respond(500, CHAT_AUTH_TEXTS.missing);
  }
  if (!user && !password) return respond(500, CHAT_AUTH_TEXTS.missing);

  const expected: DataObject = {
    kind: CHAT_TOKEN_KINDS.basic,
    tenantId: ctx.getTenantId(),
    workflowId: ctx.getWorkflow().id ?? '',
    node: ctx.getNode().name,
    credential: credentialDigest(user, password),
  };
  // the scheme is case-insensitive; a header of another scheme counts as no login
  const login = /^\s*basic\s+(\S+)\s*$/i.exec(headerValue(ctx, 'authorization') ?? '')?.[1];
  if (login !== undefined) {
    const decoded = Buffer.from(login, 'base64').toString();
    const separator = decoded.indexOf(':');
    const userOk = separator >= 0 && safeEqual(decoded.slice(0, separator), user);
    const passOk = separator >= 0 && safeEqual(decoded.slice(separator + 1), password);
    if (userOk && passOk) {
      try {
        return allow({ authToken: ctx.signFormToken(expected, BASIC_TOKEN_TTL_SECONDS) });
      } catch {
        // a host without a token signer: the login itself still opens the chat
        return allow();
      }
    }
    return respond(403, CHAT_AUTH_TEXTS.wrong);
  }
  const token = allowToken ? headerValue(ctx, CHAT_AUTH_HEADER) : undefined;
  if (token === undefined) return respond(401, CHAT_AUTH_TEXTS.required);
  const payload = ctx.verifyFormToken(token);
  if (payload && Object.entries(expected).every(([key, value]) => payload[key] === value)) {
    return allow({ authToken: token });
  }
  return respond(403, CHAT_AUTH_TEXTS.wrong);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** the page of a refused sign-in: plain, no script, the message written as escaped text */
function refusalPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Problem loading chat</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Problem loading chat</h1><p>${escapeHtml(message)}</p></body></html>`;
}

async function userAccess(
  ctx: WebhookContext,
  corsOrigin: string | undefined,
  requireExecuteAccess: boolean,
): Promise<ChatAccess> {
  const result = await checkUserAuth(ctx, {
    scope: 'trigger',
    requireExecuteAccess,
    tokenKind: CHAT_TOKEN_KINDS.user,
    cookieName: `ncb-chat-auth-wf-${ctx.getWorkflow().id ?? ''}`,
    cookiePath: ctx.getRequestObject().url?.split('?')[0] ?? '',
    texts: USER_AUTH_TEXTS,
    refusalPage,
  });
  if (!result.allowed) {
    const response = result.response ?? { statusCode: 403, body: { message: USER_AUTH_TEXTS.noPermission } };
    const cors: Record<string, string> = corsOrigin
      ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' }
      : {};
    return refuse({ webhookResponse: { ...response, headers: { ...cors, ...response.headers } } });
  }
  return allow({ user: result.user, authToken: result.token, headers: result.headers });
}

/**
 * The gate of a chat request. A chat that is not public answers only a test run from the editor that holds
 * its test token; with `DISABLE_PUBLIC_CHAT_TRIGGER` on, a public URL answers 404 and test runs still work.
 * A refused Origin (`originRefused`) answers 403 only after these two rules, so it never tells a caller that
 * a closed chat exists. An editor's test run with its test token then passes, as n8n's canvas chat is never
 * stopped by the login; every other caller of a public chat meets its Authentication option. `allowToken`
 * is false for the page's GET, which asks for the login (or the sign-in) every time.
 */
export async function checkChatAccess(
  ctx: WebhookContext,
  corsOrigin: string | undefined,
  allowToken: boolean,
  originRefused = false,
): Promise<ChatAccess> {
  const notAvailable = () => refuse(chatResponse(404, { message: NOT_AVAILABLE }, corsOrigin));
  const manual = ctx.getMode() === 'manual';
  const testRun = manual && holdsToken(ctx, CHAT_TEST_HEADER, CHAT_TOKEN_KINDS.test);
  if (!ctx.getNodeParameter('public', 0, false)) {
    if (!testRun) return notAvailable();
  } else if (!manual && ctx.isPublicChatDisabled()) {
    return notAvailable();
  }
  if (originRefused) return refuse(chatResponse(403, { message: 'Origin not allowed' }));
  if (testRun) return allow();

  const authentication = ctx.getNodeParameter('authentication', 0, 'none');
  if (authentication === 'basicAuth') return basicAccess(ctx, corsOrigin, allowToken);
  if (authentication === 'n8nUserAuth') {
    return userAccess(ctx, corsOrigin, ctx.getNodeParameter('requireExecuteAccess', 0, false) === true);
  }
  return allow();
}

function textOf(content: AiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** one stored message in the serialised shape the widget reads (`kwargs.content`, the class in `id`) */
function serialised(kind: 'HumanMessage' | 'AIMessage', content: string): DataObject {
  return {
    lc: 1,
    type: 'constructor',
    id: ['langchain_core', 'messages', kind],
    kwargs: { content, additional_kwargs: {}, response_metadata: {} },
  };
}

/**
 * `loadPreviousSession` with `memory`: the full stored history (never windowed) of the memory node wired
 * to this trigger, oldest first. Messages a Chat Memory Manager marked `hideFromUI` and messages that are
 * neither the person's nor the assistant's text are left out. The memory node scopes the session key
 * itself, so only the memory node the Agent uses shows the Agent's conversation.
 */
export async function loadChatHistory(ctx: WebhookContext, sessionId: string): Promise<DataObject[]> {
  const raw = await ctx.getInputConnectionData('ai_memory', 0);
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value = Array.isArray(first) ? first[0] : first;
  if (!value || typeof value !== 'object' || (value as { kind?: string }).kind !== 'memory') return [];
  const memory = value as AiMemory & { sessionId?: string };
  const messages = await memory.loadAll(memory.sessionId ?? sessionId);
  const out: DataObject[] = [];
  for (const message of messages) {
    if (message.hideFromUI) continue;
    const text = textOf(message.content);
    if (!text) continue;
    if (message.role === 'user') out.push(serialised('HumanMessage', text));
    else if (message.role === 'assistant') out.push(serialised('AIMessage', text));
  }
  return out;
}
