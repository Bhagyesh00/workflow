/**
 * P5-67 (L1): thread compaction on the scripted fake. A long session folds its oldest messages into the
 * thread's observations (one model call with our own prompt), the next request holds the notes and fewer
 * messages, and the chat goes on; one long turn shrinks between its model calls and keeps its own user
 * message; the reflector condenses notes over its limit; the messages route still lists every message.
 */
import type { AssistantMessagesPage } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ASSISTANT_OBSERVER_PROMPT,
  ASSISTANT_REFLECTOR_PROMPT,
  messageGroups,
} from '../src/services/assistant/compaction';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { type AssistantHarness, createAssistantHarness } from './fakes/assistant-harness';
import type { FakeLlmReply, FakeLlmRequestBody } from './fakes/fake-llm';

type Message = { role?: string; content?: unknown; tool_calls?: unknown };

const systemOf = (body: FakeLlmRequestBody) =>
  String((body.messages?.[0] as Message | undefined)?.content ?? '');
const isObserver = (body: FakeLlmRequestBody) => systemOf(body) === ASSISTANT_OBSERVER_PROMPT;
const isReflector = (body: FakeLlmRequestBody) => systemOf(body) === ASSISTANT_REFLECTOR_PROMPT;

const bigTool: AssistantToolDefinition<{ n: number }> = {
  name: 'big_read',
  description: 'Read a lot',
  input: z.object({ n: z.number() }),
  minRole: 'viewer',
  async handler(_ctx, _run, input) {
    return `chunk ${input.n}: ${'lorem ipsum '.repeat(120)}`;
  },
};

function responder(answer: (body: FakeLlmRequestBody) => FakeLlmReply) {
  return (body: FakeLlmRequestBody): FakeLlmReply => {
    if (isObserver(body))
      return { text: `NOTES-${Math.random().toString(36).slice(2, 8)}: the person asked things` };
    if (isReflector(body)) return { text: 'CONDENSED-NOTES' };
    return answer(body);
  };
}

describe('Assistant compaction', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness({
      extraTools: [bigTool],
      config: {
        INSTANCE_AI_OBSERVER_MESSAGE_TOKENS: '400',
        INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS: '100000',
      },
    });
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => {
    h.script.length = h.fake.requests.length;
  });

  it('folds a long session into notes; the next request holds them and fewer messages, and it goes on', async () => {
    const threadId = await h.createThread(h.editor);
    const step = responder(() => ({ text: `Answer ${'detail '.repeat(80)}` }));
    h.script.push(...Array.from({ length: 30 }, () => step));
    for (let i = 1; i <= 4; i++) {
      await h.chat(h.editor, threadId, `Question ${i}: ${'please explain '.repeat(20)}`);
      await h.waitForStatus(h.editor, threadId, 'idle');
    }
    const bodies = h.fake.requests as FakeLlmRequestBody[];
    expect(bodies.some(isObserver)).toBe(true);
    const chats = bodies.filter((b) => !isObserver(b) && !isReflector(b));
    const last = chats.at(-1) as FakeLlmRequestBody;
    expect(systemOf(last)).toContain('NOTES-');
    expect(systemOf(last)).toContain('<untrusted_data source="thread-notes">');
    // 4 user and 3 earlier answers would be 8 messages with the system one: the view is shorter
    expect(last.messages?.length ?? 0).toBeLessThan(8);
    expect(JSON.stringify(last.messages)).toContain('Question 4');
    // the observer read the folded part as data
    const observer = bodies.find(isObserver) as FakeLlmRequestBody;
    expect(JSON.stringify(observer.messages)).toContain('<untrusted_data source=\\"conversation\\">');

    const page = await h.editor.client.data<AssistantMessagesPage>(
      h.editor.client.get(`/rest/assistant/threads/${threadId}/messages`),
    );
    expect(page.messages).toHaveLength(8);
    expect(page.messages.some((m) => m.summarized)).toBe(true);
    expect(page.messages.at(-1)?.summarized).toBe(false);
    h.checkRequests();
  });

  it('shrinks one long turn between its model calls and keeps its own user message', async () => {
    const threadId = await h.createThread(h.viewer);
    let calls = 0;
    const step = responder(() => {
      calls++;
      return calls <= 4
        ? { toolCalls: [{ id: `big_${calls}`, name: 'big_read', arguments: { n: calls } }] }
        : { text: 'All read.' };
    });
    h.script.push(...Array.from({ length: 20 }, () => step));
    const own = 'Read all four chunks and summarize them for me';
    await h.chat(h.viewer, threadId, own);
    await h.waitForStatus(h.viewer, threadId, 'idle');

    const start = h.fake.requests.length;
    const bodies = (h.fake.requests as FakeLlmRequestBody[]).slice(0, start);
    const chats = bodies.filter(
      (b) => !isObserver(b) && !isReflector(b) && JSON.stringify(b.messages).includes(own),
    );
    expect(chats.length).toBe(5);
    const last = chats.at(-1) as FakeLlmRequestBody;
    // runAgent's own array would hold system, user and 4 call/result pairs (10): the stored view is shorter
    expect(last.messages?.length ?? 0).toBeLessThan(10);
    expect(systemOf(last)).toContain('NOTES-');
    // the user message stays in every request of the turn, as the request's own copy
    for (const body of chats) {
      expect((body.messages as Message[]).filter((m) => m.role === 'user' && m.content === own)).toHaveLength(
        1,
      );
    }
    const page = await h.viewer.client.data<AssistantMessagesPage>(
      h.viewer.client.get(`/rest/assistant/threads/${threadId}/messages`),
    );
    expect(page.messages.at(-1)?.content).toBe('All read.');
    h.checkRequests();
  });

  it('condenses the notes once they pass the reflector limit', async () => {
    await h.close();
    h = await createAssistantHarness({
      config: { INSTANCE_AI_OBSERVER_MESSAGE_TOKENS: '300', INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS: '10' },
    });
    const threadId = await h.createThread(h.owner);
    const step = responder(() => ({ text: `Reply ${'words '.repeat(80)}` }));
    h.script.push(...Array.from({ length: 30 }, () => step));
    for (let i = 1; i <= 3; i++) {
      await h.chat(h.owner, threadId, `Ask ${i}: ${'more text '.repeat(30)}`);
      await h.waitForStatus(h.owner, threadId, 'idle');
    }
    const bodies = h.fake.requests as FakeLlmRequestBody[];
    expect(bodies.some(isReflector)).toBe(true);
    const thread = await h.ctx.repos.assistantThreads.get(h.tenantId, h.owner.userId, threadId);
    expect(thread?.observations).toBe('CONDENSED-NOTES');
  });

  it('never splits a tool call from its results when grouping', () => {
    const row = (seq: number, role: 'user' | 'assistant' | 'tool', extra: Record<string, unknown> = {}) =>
      ({ seq, role, content: '', toolCalls: null, toolCallId: null, ...extra }) as never;
    const groups = messageGroups([
      row(1, 'user'),
      row(2, 'assistant', {
        toolCalls: [
          { id: 'a', name: 't', arguments: {} },
          { id: 'b', name: 't', arguments: {} },
        ],
      }),
      row(3, 'tool', { toolCallId: 'b' }),
      row(4, 'tool', { toolCallId: 'a' }),
      row(5, 'assistant'),
    ]);
    expect(groups.map((g) => g.map((m: { seq: number }) => m.seq))).toEqual([[1], [2, 3, 4], [5]]);
  });
});
