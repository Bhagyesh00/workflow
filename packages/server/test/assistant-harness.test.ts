/**
 * Phase 5 S5 C0e: the Assistant test harness itself (test/fakes/assistant-harness.ts). Its request scan
 * (dangling tool call ids, duplicate tool names), the SSE frame parser, and that one harness builds the
 * four roles, the fake's model setting and the second tenant's canaries.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  HARNESS_MODEL,
  parseSseEvents,
  recordedRequestProblems,
  toolResultOf,
} from './fakes/assistant-harness';

const echo: AssistantToolDefinition = {
  name: 'harness_echo',
  description: 'Echo the input (test seam)',
  input: z.object({ text: z.string() }),
  minRole: 'editor',
  async handler(_ctx, _run, input) {
    return input;
  },
};

describe('recordedRequestProblems', () => {
  const call = (id: string, name = 'search') => ({
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  });

  it('passes answered tool calls and distinct tool names', () => {
    const requests = [
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ function: { name: 'a' } }, { function: { name: 'b' } }],
      },
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')] },
          { role: 'tool', tool_call_id: 'c1', content: 'one' },
          { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'two' }] },
        ],
      },
    ];
    expect(recordedRequestProblems(requests)).toEqual([]);
    expect(toolResultOf(requests, 'c1')).toBe('one');
    expect(toolResultOf(requests, 'c2')).toBe('two');
    expect(toolResultOf(requests, 'c3')).toBeUndefined();
  });

  it('fails on a dangling tool call id and on a tool name offered twice', () => {
    const problems = recordedRequestProblems([
      {
        messages: [
          { role: 'assistant', tool_calls: [call('c1'), call('c2')] },
          { role: 'tool', tool_call_id: 'c1', content: 'one' },
        ],
        tools: [{ function: { name: 'a' } }, { function: { name: 'a' } }],
      },
    ]);
    expect(problems).toEqual([
      'request 1: tool call "c2" has no tool message',
      'request 1: tool "a" is offered twice',
    ]);
  });
});

describe('parseSseEvents', () => {
  it('reads id, event and JSON data lines and skips comments', () => {
    const text = [
      ': keep-alive',
      '',
      'id: 4',
      'event: text-delta',
      'data: {"runId":"r1","payload":{"text":"Hi"}}',
      '',
      'id: 5',
      'data: {"type":"run-finish","id":5,"runId":"r1","payload":{}}',
      '',
      'data: not json',
      '',
    ].join('\n');
    expect(parseSseEvents(text)).toEqual([
      { type: 'text-delta', id: 4, runId: 'r1', payload: { text: 'Hi' } },
      { type: 'run-finish', id: 5, runId: 'r1', payload: {} },
    ]);
  });
});

describe('createAssistantHarness', () => {
  let harness: AssistantHarness;

  beforeAll(async () => {
    harness = await createAssistantHarness({ script: [{ text: 'Hello' }], extraTools: [echo] });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('builds Owner, Admin, Editor and Viewer in one tenant', async () => {
    const { ctx, tenantId } = harness;
    for (const role of ['owner', 'admin', 'editor', 'viewer'] as const) {
      const user = harness.users[role];
      expect(user.role).toBe(role);
      expect(user.tenantId).toBe(tenantId);
      expect((await ctx.repos.memberships.get(tenantId, user.userId))?.role).toBe(role);
      const me = await user.client.get('/rest/settings');
      expect(me.statusCode).toBe(200);
    }
    expect(harness.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('sets the fake as the tenant model and passes the extra tools', async () => {
    const { ctx, tenantId } = harness;
    const tenant = await ctx.repos.tenants.get(tenantId);
    const settings = await ctx.assistantSettings.read(tenant!);
    expect(settings.model).toEqual({ credentialId: harness.modelCredentialId, ...HARNESS_MODEL });
    expect(settings.enabled).toBe(true);
    const feature = await harness.owner.client.data<{ features: { assistant: unknown } }>(
      harness.owner.client.get('/rest/settings'),
    );
    expect(feature.features.assistant).toEqual({ enabled: true, modelSet: true });
    expect(ctx.assistant.extraTools).toEqual([echo]);
    await harness.expectToolRoles({ harness_echo: 'workflow:update' });

    await harness.setSettings({ enabled: false });
    expect((await harness.viewer.client.get('/rest/assistant/threads')).statusCode).toBe(404);
    await harness.setSettings({});
    const after = await ctx.assistantSettings.read((await ctx.repos.tenants.get(tenantId))!);
    expect(after.enabled).toBe(true);
    expect(after.model?.credentialId).toBe(harness.modelCredentialId);
  });

  it("builds the second tenant's canaries, out of the first tenant's reach", async () => {
    const { other, owner, ctx } = harness;
    expect(other.tenantId).not.toBe(harness.tenantId);
    expect((await ctx.repos.workflows.get(other.tenantId, other.workflowId))?.name).toBe(CANARY.workflow);
    expect((await ctx.repos.credentials.get(other.tenantId, other.credentialId))?.name).toBe(
      CANARY.credential,
    );
    expect((await other.owner.client.get(`/rest/data-tables/${other.dataTableId}`)).statusCode).toBe(200);
    expect((await owner.client.get(`/rest/workflows/${other.workflowId}`)).statusCode).toBe(404);
    expect((await owner.client.get(`/rest/credentials/${other.credentialId}`)).statusCode).toBe(404);
    expect((await owner.client.get(`/rest/data-tables/${other.dataTableId}`)).statusCode).toBe(404);
  });

  it("checks the fake's recorded requests", async () => {
    expect(harness.fake.requests).toEqual([]);
    expect(() => harness.checkRequests()).not.toThrow();
    harness.expectNoCanary();
    // a bad request recorded by the fake fails the check (removed again so close passes)
    harness.fake.requests.push({ messages: [{ role: 'assistant', tool_calls: [{ id: 'x1' }] }] });
    expect(() => harness.checkRequests()).toThrow(/tool call "x1" has no tool message/);
    harness.fake.requests.pop();
  });
});
