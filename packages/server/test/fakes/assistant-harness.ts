/**
 * The Assistant test harness (P5-67, C0 FULL, for lanes L1 to L11). `createAssistantHarness` starts S4's
 * fake LLM (127.0.0.1, scripted text and tool calls), a test server with the AI runtime and the
 * `assistantTools` seam, listening on 127.0.0.1 (the SSE event stream needs a real socket), and two
 * tenants:
 * - the workspace under test: Owner, Admin, Editor and Viewer, an OpenAI-compatible credential pointing
 *   at the fake, and `TenantSettings.assistant` set to it (plus `settings`);
 * - a second workspace with its own workflow, credential and data table (the canaries): nothing of it may
 *   ever reach a model or a response of the first one (`expectNoCanary`).
 *
 * At each `waitForStatus` and at `close` the harness scans every request the fake recorded and fails the
 * test on a `tool_calls` id with no tool message answering it, or on a tool name offered twice in one
 * request: `startFakeLlm` accepts both, real providers refuse them.
 */
import { capabilitiesOf, nodesAiPackage, runAgent } from '@workflow/nodes-ai';
import type {
  AssistantConfirmAnswer,
  AssistantEvent,
  AssistantStatusDTO,
  DataObject,
} from '@workflow/workflow';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { Role } from '../../src/db/schema';
import type { TenantSettings } from '../../src/plans';
import type { AiRuntime } from '../../src/services/ai-builder/runtime';
import {
  type AssistantTenantSettings,
  effectiveAssistantSettings,
} from '../../src/services/assistant/settings';
import { assistantTools, builtInAssistantTools } from '../../src/services/assistant/tools';
import type { AssistantToolDefinition } from '../../src/services/assistant/types';
import { hasRole } from '../../src/services/auth';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  signup,
  type TestClient,
  type TestServer,
  waitFor,
} from '../helpers';
import { type FakeLlm, type FakeLlmStep, startFakeLlm } from './fake-llm';

/** the chat model node and model name the harness sets up */
export const HARNESS_MODEL = { nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' } as const;

/** the second workspace's names and secret: none may appear in a model request or a first-tenant answer */
export const CANARY = {
  workspace: 'Canary workspace',
  workflow: 'Canary workflow',
  credential: 'Canary credential',
  dataTable: 'Canary table',
  secret: 'sk-canary-secret-0000000000000000',
} as const;

export const HARNESS_ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer'];

export interface HarnessUser {
  client: TestClient;
  userId: string;
  email: string;
  role: Role;
  tenantId: string;
}

export interface HarnessCanaries {
  owner: HarnessUser;
  tenantId: string;
  workflowId: string;
  credentialId: string;
  dataTableId: string;
}

export interface AssistantHarnessOptions {
  /** the fake LLM's script; `callTool` inserts its own steps at the next unused position */
  script?: FakeLlmStep[];
  /** test seam: tools offered after the built-in ones (`createTestServer`'s `assistantTools`) */
  extraTools?: AssistantToolDefinition[];
  /** merged over the harness's `TenantSettings.assistant` (credential, node type and model of the fake) */
  settings?: Partial<AssistantTenantSettings>;
  /** env overrides for `createTestServer` */
  config?: Record<string, string>;
}

export interface EventsOptions {
  /** stop once this holds for the events read so far */
  until?: (events: AssistantEvent[]) => boolean;
  /** stop after this long without a new event (default 300 ms) */
  idleMs?: number;
  /** stop after this long in any case (default 10 s) */
  timeoutMs?: number;
}

export type StatusWanted = 'idle' | 'running' | 'suspended' | ((status: AssistantStatusDTO) => boolean);

export interface CallToolResult {
  threadId: string;
  runId: string;
  toolCallId: string;
  /** the tool message the model got back (undefined while a card waits) */
  result: string | undefined;
  status: AssistantStatusDTO;
}

export interface AssistantHarness {
  server: TestServer;
  ctx: TestServer['ctx'];
  app: TestServer['app'];
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  fake: FakeLlm;
  /** the live script (the fake reads it by position) */
  script: FakeLlmStep[];
  tenantId: string;
  /** the OpenAI-compatible credential of the fake (first tenant) */
  modelCredentialId: string;
  owner: HarnessUser;
  admin: HarnessUser;
  editor: HarnessUser;
  viewer: HarnessUser;
  /** the four legacy-era roles (a `member` is made per test with `realMember`) */
  users: Record<Exclude<Role, 'member'>, HarnessUser>;
  other: HarnessCanaries;
  extraTools: AssistantToolDefinition[];
  /** replaces `TenantSettings.assistant` of the first tenant (merged over the harness's model setup) */
  setSettings(settings: Partial<AssistantTenantSettings>): Promise<void>;
  /** POST /rest/assistant/threads; the new thread's id */
  createThread(user: HarnessUser, title?: string): Promise<string>;
  /** POST /rest/assistant/chat/:threadId; fails on an HTTP error */
  chat(user: HarnessUser, threadId: string, text: string): Promise<{ runId: string }>;
  /** the thread's SSE events after `afterId` (Last-Event-ID), read until `until`, idle or the timeout */
  events(
    user: HarnessUser,
    threadId: string,
    afterId?: number,
    options?: EventsOptions,
  ): Promise<AssistantEvent[]>;
  /** GET /rest/assistant/threads/:threadId/status */
  status(user: HarnessUser, threadId: string): Promise<AssistantStatusDTO>;
  /** polls the status until it matches, then scans the recorded requests */
  waitForStatus(
    user: HarnessUser,
    threadId: string,
    wanted: StatusWanted,
    timeoutMs?: number,
  ): Promise<AssistantStatusDTO>;
  /** POST /rest/assistant/confirm/:requestId */
  confirm(
    user: HarnessUser,
    requestId: string,
    answer: AssistantConfirmAnswer,
  ): Promise<LightMyRequestResponse>;
  /** each named tool exists with this minimum role, and is offered to exactly the roles at or above it */
  expectToolRoles(table: Record<string, Role>): Promise<void>;
  /** a scripted model call of `name(args)` through the whole path (thread, chat, run loop, tool, result) */
  callTool(user: HarnessUser, name: string, args: DataObject): Promise<CallToolResult>;
  /** fails on a dangling tool call id or a duplicate tool name in any recorded request */
  checkRequests(): void;
  /** fails when a canary name, id or secret is in any recorded request */
  expectNoCanary(): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// request checks

type RecordedMessage = { role?: unknown; tool_calls?: unknown; tool_call_id?: unknown };

/**
 * The problems of the recorded requests (empty when none): a `tool_calls` id that no tool message of
 * the same request answers, or a tool name offered twice in one request.
 */
export function recordedRequestProblems(requests: unknown[]): string[] {
  const problems: string[] = [];
  requests.forEach((raw, index) => {
    const request = (raw ?? {}) as { messages?: unknown; tools?: unknown };
    const messages = Array.isArray(request.messages) ? (request.messages as RecordedMessage[]) : [];
    const answered = new Set(
      messages
        .filter((m) => m?.role === 'tool' && typeof m.tool_call_id === 'string')
        .map((m) => m.tool_call_id as string),
    );
    for (const message of messages) {
      if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls as Array<{ id?: unknown }>) {
        const id = typeof call?.id === 'string' ? call.id : String(call?.id);
        if (!answered.has(id)) problems.push(`request ${index + 1}: tool call "${id}" has no tool message`);
      }
    }
    const tools = Array.isArray(request.tools)
      ? (request.tools as Array<{ function?: { name?: unknown } }>)
      : [];
    const seen = new Set<string>();
    for (const tool of tools) {
      const name = String(tool?.function?.name ?? '');
      if (seen.has(name)) problems.push(`request ${index + 1}: tool "${name}" is offered twice`);
      seen.add(name);
    }
  });
  return problems;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/** the text of the tool message answering `toolCallId` in any recorded request */
export function toolResultOf(requests: unknown[], toolCallId: string): string | undefined {
  for (const raw of requests) {
    const messages = ((raw ?? {}) as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
    const found = (messages as Array<{ role?: unknown; tool_call_id?: unknown; content?: unknown }>).find(
      (m) => m?.role === 'tool' && m.tool_call_id === toolCallId,
    );
    if (found) return contentText(found.content);
  }
  return undefined;
}

/** SSE frames (`id:`, `event:`, `data:` lines) to events; a frame without JSON data is skipped */
export function parseSseEvents(text: string): AssistantEvent[] {
  const events: AssistantEvent[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    let id: number | undefined;
    let type: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const event = { ...(parsed as Record<string, unknown>) };
    if (typeof event.type !== 'string' && type) event.type = type;
    if (event.id === undefined && id !== undefined && Number.isFinite(id)) event.id = id;
    if (typeof event.type === 'string') events.push(event as unknown as AssistantEvent);
  }
  return events;
}

function statusMatches(status: AssistantStatusDTO, wanted: StatusWanted): boolean {
  if (typeof wanted === 'function') return wanted(status);
  if (wanted === 'idle') return !status.hasActiveRun && !status.isSuspended;
  if (wanted === 'suspended') return status.isSuspended;
  return status.hasActiveRun;
}

// ---------------------------------------------------------------------------------------------
// the harness

let harnessCount = 0;

/** a private address per harness, so the signup limit (20 an hour per IP) never trips */
function harnessAddress(): string {
  harnessCount++;
  return `10.67.${Math.floor(harnessCount / 250) % 250}.${(harnessCount % 250) + 1}`;
}

async function invite(owner: HarnessUser, role: Role, address: string): Promise<HarnessUser> {
  const { client, user, email } = await memberAs(owner, role, {
    name: `Harness ${role}`,
    remoteAddress: address,
  });
  return { client, userId: user.id, email, role, tenantId: owner.tenantId };
}

export async function createAssistantHarness(
  options: AssistantHarnessOptions = {},
): Promise<AssistantHarness> {
  const script: FakeLlmStep[] = [...(options.script ?? [])];
  const extraTools = options.extraTools ?? [];
  const fake = await startFakeLlm(script);
  const aiRuntime: AiRuntime = { runAgent, capabilitiesOf };
  let server: TestServer | undefined;
  try {
    server = await createTestServer(options.config ?? {}, {
      nodePackages: [nodesAiPackage],
      aiRuntime,
      assistantTools: extraTools,
    });
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
    const { ctx, app } = server;
    const address = harnessAddress();

    // the workspace under test
    const first = await signup(app, { remoteAddress: address, workspaceName: 'Assistant workspace' });
    const owner: HarnessUser = {
      client: first.client,
      userId: first.user.id,
      email: first.user.email,
      role: 'owner',
      tenantId: first.tenant.id,
    };
    const admin = await invite(owner, 'admin', address);
    const editor = await invite(owner, 'editor', address);
    const viewer = await invite(owner, 'viewer', address);
    const credential = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/credentials', {
        name: 'Assistant model',
        type: 'openAiApi',
        data: { apiKey: 'sk-test-assistant-key-00000000000', baseUrl: fake.baseUrl },
      }),
    );
    const tenantId = owner.tenantId;
    const baseSettings: AssistantTenantSettings = {
      credentialId: credential.id,
      nodeType: HARNESS_MODEL.nodeType,
      model: HARNESS_MODEL.model,
    };
    const setSettings = async (settings: Partial<AssistantTenantSettings>) => {
      const row = await ctx.repos.tenants.get(tenantId);
      const current = (row?.settings ?? {}) as TenantSettings;
      await ctx.repos.tenants.updateSettings(tenantId, {
        ...current,
        assistant: { ...baseSettings, ...settings },
      } as Record<string, unknown>);
    };
    await setSettings(options.settings ?? {});

    // the canaries
    const second = await signup(app, { remoteAddress: address, workspaceName: CANARY.workspace });
    const otherOwner: HarnessUser = {
      client: second.client,
      userId: second.user.id,
      email: second.user.email,
      role: 'owner',
      tenantId: second.tenant.id,
    };
    const canaryWorkflow = await createWorkflow(otherOwner.client, {
      name: CANARY.workflow,
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const canaryCredential = await otherOwner.client.data<{ id: string }>(
      otherOwner.client.post('/rest/credentials', {
        name: CANARY.credential,
        type: 'openAiApi',
        data: { apiKey: CANARY.secret, baseUrl: fake.baseUrl },
      }),
    );
    const canaryTable = await otherOwner.client.data<{ id: string }>(
      otherOwner.client.post('/rest/data-tables', {
        name: CANARY.dataTable,
        columns: [{ name: 'secret', type: 'string' }],
      }),
    );
    const other: HarnessCanaries = {
      owner: otherOwner,
      tenantId: otherOwner.tenantId,
      workflowId: canaryWorkflow.id,
      credentialId: canaryCredential.id,
      dataTableId: canaryTable.id,
    };

    const checkRequests = () => {
      const problems = recordedRequestProblems(fake.requests);
      if (problems.length)
        throw new Error(`The model was sent requests a provider refuses:\n${problems.join('\n')}`);
    };

    const expectNoCanary = () => {
      const sent = JSON.stringify(fake.requests);
      for (const value of [
        CANARY.workspace,
        CANARY.workflow,
        CANARY.credential,
        CANARY.dataTable,
        CANARY.secret,
        other.tenantId,
        other.workflowId,
        other.credentialId,
        other.dataTableId,
      ]) {
        expect(sent, `a canary (${value}) reached the model`).not.toContain(value);
      }
    };

    const createThread = async (user: HarnessUser, title?: string) => {
      const thread = await user.client.data<{ id: string }>(
        user.client.post('/rest/assistant/threads', title === undefined ? {} : { title }),
      );
      return thread.id;
    };

    const chat = (user: HarnessUser, threadId: string, text: string) =>
      user.client.data<{ runId: string }>(
        user.client.post(`/rest/assistant/chat/${threadId}`, { message: text }),
      );

    const status = (user: HarnessUser, threadId: string) =>
      user.client.data<AssistantStatusDTO>(user.client.get(`/rest/assistant/threads/${threadId}/status`));

    const waitForStatus = async (
      user: HarnessUser,
      threadId: string,
      wanted: StatusWanted,
      timeoutMs = 15_000,
    ) => {
      const found = await waitFor(
        async () => {
          const current = await status(user, threadId);
          return statusMatches(current, wanted) ? current : undefined;
        },
        { timeout: timeoutMs, interval: 50, message: `thread ${threadId} status ${String(wanted)}` },
      );
      checkRequests();
      return found;
    };

    const events = async (
      user: HarnessUser,
      threadId: string,
      afterId = 0,
      eventOptions: EventsOptions = {},
    ) => {
      const idleMs = eventOptions.idleMs ?? 300;
      const deadline = Date.now() + (eventOptions.timeoutMs ?? 10_000);
      const controller = new AbortController();
      const read: AssistantEvent[] = [];
      try {
        const res = await fetch(`${baseUrl}/rest/assistant/events/${threadId}`, {
          headers: {
            accept: 'text/event-stream',
            ...(user.client.cookie ? { cookie: user.client.cookie } : {}),
            ...(afterId > 0 ? { 'last-event-id': String(afterId) } : {}),
          },
          signal: controller.signal,
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        if (!res.body) return read;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<'idle'>((resolve) =>
              setTimeout(() => resolve('idle'), Math.min(idleMs, left)).unref(),
            ),
          ]);
          if (chunk === 'idle' || chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const cut = buffer.lastIndexOf('\n\n');
          if (cut >= 0) {
            read.push(...parseSseEvents(buffer.slice(0, cut + 2)));
            buffer = buffer.slice(cut + 2);
          }
          if (eventOptions.until?.(read)) break;
        }
        return read;
      } finally {
        controller.abort();
      }
    };

    const confirm = (user: HarnessUser, requestId: string, answer: AssistantConfirmAnswer) =>
      user.client.post(`/rest/assistant/confirm/${requestId}`, answer);

    const expectToolRoles = async (table: Record<string, Role>) => {
      const row = await ctx.repos.tenants.get(tenantId);
      const settings = effectiveAssistantSettings(ctx.config, (row?.settings ?? {}) as TenantSettings);
      const all = [...builtInAssistantTools(), ...extraTools];
      for (const [name, minRole] of Object.entries(table)) {
        const def = all.find((d) => d.name === name);
        expect(def, `tool ${name} exists`).toBeDefined();
        expect(def?.minRole, `minimum role of ${name}`).toBe(minRole);
        for (const role of HARNESS_ROLES) {
          const offered = assistantTools(role, settings, extraTools).some((d) => d.name === name);
          expect(offered, `${name} offered to ${role}`).toBe(hasRole(role, minRole));
        }
      }
    };

    let callCount = 0;
    const callTool = async (user: HarnessUser, name: string, args: DataObject): Promise<CallToolResult> => {
      callCount++;
      const toolCallId = `harness_call_${callCount}`;
      // the fake reads the script by position: put the call and the closing text at the next unused step
      script.splice(
        fake.requests.length,
        0,
        { toolCalls: [{ id: toolCallId, name, arguments: args }] },
        { text: 'Done.' },
      );
      const threadId = await createThread(user);
      const { runId } = await chat(user, threadId, `Call ${name}`);
      const final = await waitForStatus(user, threadId, (s) => !s.hasActiveRun || s.isSuspended);
      return { threadId, runId, toolCallId, result: toolResultOf(fake.requests, toolCallId), status: final };
    };

    const harness: AssistantHarness = {
      server,
      ctx,
      app,
      baseUrl,
      fake,
      script,
      tenantId,
      modelCredentialId: credential.id,
      owner,
      admin,
      editor,
      viewer,
      users: { owner, admin, editor, viewer },
      other,
      extraTools,
      setSettings,
      createThread,
      chat,
      events,
      status,
      waitForStatus,
      confirm,
      expectToolRoles,
      callTool,
      checkRequests,
      expectNoCanary,
      async close() {
        try {
          await server?.close();
        } finally {
          await fake.close();
        }
        checkRequests();
      },
    };
    return harness;
  } catch (error) {
    await server?.close().catch(() => {});
    await fake.close().catch(() => {});
    throw error;
  }
}
