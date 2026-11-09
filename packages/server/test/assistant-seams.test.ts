/**
 * P5-67 (L1): the seams the run loop calls in other lanes' files, with `vi.mock` on
 * services/assistant/mcp.ts (L9) and attachments.ts (L11): a tool from `openMcpTools` reaches the
 * model's tool list and its `close` runs in the turn's `finally`; `attachmentImages`' output reaches
 * the request and a resumed turn reloads the files; a definition with `available` false is absent, and
 * a forged call to it gets an error result; `artifact` is emitted; a user demoted during the turn is
 * refused at the call.
 */
import type { AssistantEvent } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AccessTarget, MISSING_SCOPE_MESSAGE } from '../src/services/access';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { type AssistantHarness, createAssistantHarness, toolResultOf } from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';

const seams = vi.hoisted(() => ({
  mcpClose: 0,
  mcpOpened: 0,
  stored: [] as unknown[],
  images: 0,
}));

vi.mock('../src/services/assistant/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/assistant/mcp')>();
  const { z: zod } = await import('zod');
  return {
    ...original,
    openMcpTools: vi.fn(async () => {
      seams.mcpOpened++;
      return {
        tools: [
          {
            name: 'mcp_docs_search',
            description: 'Search the docs server',
            input: zod.object({ query: zod.string() }),
            access: 'instanceAi:message',
            untrusted: 'mcp:docs',
            async handler(_ctx: unknown, _run: unknown, input: { query: string }) {
              return `found: ${input.query}`;
            },
          },
        ],
        close: async () => {
          seams.mcpClose++;
        },
      };
    }),
  };
});

vi.mock('../src/services/assistant/attachments', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/assistant/attachments')>();
  return {
    ...original,
    validateAttachments: vi.fn(() => {}),
    storeAttachments: vi.fn(async (_ctx: unknown, _tenantId: string, _threadId: string, list: unknown[]) =>
      list.map(() => ({
        fileName: 'chart.png',
        mimeType: 'image/png',
        size: 4,
        binary: { data: 'iVBO', mimeType: 'image/png', fileName: 'chart.png' },
      })),
    ),
    attachmentImages: vi.fn(async (_ctx: unknown, _tenantId: string, list: unknown[]) => {
      seams.images++;
      return list.length ? [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] : [];
    }),
  };
});

let hidden = 0;
const hiddenTool: AssistantToolDefinition<Record<string, never>> = {
  name: 'hidden_tool',
  description: 'Never offered',
  input: z.object({}),
  access: 'instanceAi:message',
  available: () => false,
  async handler() {
    hidden++;
    return 'ran';
  },
};

/** P6-39: what `make_table` acts on (null: the caller's home, its personal project); set by the demotion case */
let tableTarget: AccessTarget | null = null;

const makeTable: AssistantToolDefinition<{ name: string }> = {
  name: 'make_table',
  description: 'Make a table',
  input: z.object({ name: z.string() }),
  access: 'workflow:update',
  target: () => tableTarget,
  artifact: (input, result) => ({
    type: 'data-table',
    id: String((result as { id: string }).id),
    name: input.name,
  }),
  async handler(_ctx, _run, input) {
    return { id: 'table-1', name: input.name };
  },
};

function queue(h: AssistantHarness, ...steps: FakeLlmStep[]) {
  // the fake reads by request count: fill the places of requests already made (provider retries)
  while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
  h.script.splice(h.fake.requests.length, 0, ...steps);
}

type Body = { messages?: Array<Record<string, unknown>>; tools?: Array<{ function?: { name?: string } }> };

describe('Assistant seams', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness({ extraTools: [hiddenTool, makeTable] });
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => {
    seams.mcpClose = 0;
    seams.mcpOpened = 0;
  });

  it('offers an MCP tool from openMcpTools, runs it, and closes it in the finally', async () => {
    const threadId = await h.createThread(h.viewer);
    queue(
      h,
      { toolCalls: [{ id: 'mcp_1', name: 'mcp_docs_search', arguments: { query: 'webhooks' } }] },
      { text: 'Found it.' },
    );
    await h.chat(h.viewer, threadId, 'Search the docs');
    await h.waitForStatus(h.viewer, threadId, 'idle');
    const first = h.fake.requests.at(-2) as Body;
    const names = (first.tools ?? []).map((t) => t.function?.name);
    expect(names).toContain('mcp_docs_search');
    expect(toolResultOf([h.fake.requests.at(-1)], 'mcp_1')).toBe(
      '<untrusted_data source="mcp:docs">\nfound: webhooks\n</untrusted_data>',
    );
    expect(seams.mcpOpened).toBe(1);
    expect(seams.mcpClose).toBe(1);

    // a failing turn still closes it
    queue(h, { status: 500, error: 'model down' });
    await h.chat(h.viewer, threadId, 'again');
    await h.waitForStatus(h.viewer, threadId, 'idle');
    expect(seams.mcpClose).toBe(2);
  });

  it('sends attachmentImages output to the model with the user text', async () => {
    const threadId = await h.createThread(h.editor);
    queue(h, { text: 'A bar chart.' });
    const res = await h.editor.client.post(`/rest/assistant/chat/${threadId}`, {
      message: 'What is in this picture?',
      attachments: [{ data: 'iVBO', mimeType: 'image/png', fileName: 'chart.png' }],
    });
    expect(res.statusCode).toBe(200);
    await h.waitForStatus(h.editor, threadId, 'idle');
    const sent = JSON.stringify((h.fake.requests.at(-1) as Body).messages);
    expect(sent).toContain('What is in this picture?');
    expect(sent).toContain('iVBORw0KGgo=');
    const page = await h.editor.client.data<{ messages: Array<{ attachments?: unknown[] }> }>(
      h.editor.client.get(`/rest/assistant/threads/${threadId}/messages`),
    );
    // refs only: never the stored binary
    expect(page.messages[0].attachments).toEqual([{ fileName: 'chart.png', mimeType: 'image/png', size: 4 }]);
    expect(JSON.stringify(page)).not.toContain('iVBO');
    // a resumed turn reloads the turn's files
    expect(await h.ctx.repos.assistantThreads.turnAttachments(h.tenantId, threadId)).toHaveLength(1);
    queue(h, { text: 'Still a bar chart.' });
    await h.ctx.assistant.resumeThread(h.tenantId, h.editor.userId, threadId, { userId: h.editor.userId });
    const resumed = JSON.stringify((h.fake.requests.at(-1) as Body).messages);
    expect(resumed).toContain('iVBORw0KGgo=');
    expect(resumed).toContain('The person answered the request above');
    const events = await h.events(h.editor, threadId);
    expect(events.filter((e) => e.type === 'run-start').map((e) => e.payload)).toEqual([
      { resumed: false },
      { resumed: true },
    ]);
  });

  it('drops a definition whose available is false; a forged call to it gets an error result', async () => {
    const threadId = await h.createThread(h.owner);
    queue(h, { toolCalls: [{ id: 'forged_hidden', name: 'hidden_tool', arguments: {} }] }, { text: 'No.' });
    await h.chat(h.owner, threadId, 'Use the hidden tool');
    await h.waitForStatus(h.owner, threadId, 'idle');
    const first = h.fake.requests.at(-2) as Body;
    expect((first.tools ?? []).map((t) => t.function?.name)).not.toContain('hidden_tool');
    expect(toolResultOf([h.fake.requests.at(-1)], 'forged_hidden')).toMatch(/^Error: There is no tool named/);
    expect(hidden).toBe(0);
    const stored = await h.ctx.repos.assistantThreads.openToolCalls(h.tenantId, threadId);
    expect(stored).toEqual([]);
  });

  it('emits the artifact a definition gives, and refuses a user demoted during the turn at the call', async () => {
    const threadId = await h.createThread(h.editor);
    queue(
      h,
      { toolCalls: [{ id: 'table_1', name: 'make_table', arguments: { name: 'Leads' } }] },
      { text: 'Made.' },
    );
    await h.chat(h.editor, threadId, 'Make a table');
    await h.waitForStatus(h.editor, threadId, 'idle');
    const events = await h.events(h.editor, threadId);
    const artifact = events.find((e) => e.type === 'artifact') as Extract<
      AssistantEvent,
      { type: 'artifact' }
    >;
    expect(artifact.payload.artifact).toEqual({ type: 'data-table', id: 'table-1', name: 'Leads' });

    // demoted between the list and the call: the tool was offered, the call is refused. P6-39: the tool acts
    // on the team project, where the editor becomes a project viewer
    const team = h.owner.client.defaultProjectId!;
    tableTarget = { projectId: team };
    const setRole = (role: string) =>
      h.ctx.database.pool.query(
        'update project_relations set role = $4 where tenant_id = $1 and project_id = $2 and user_id = $3',
        [h.tenantId, team, h.editor.userId, `project:${role}`],
      );
    try {
      const other = await h.createThread(h.editor);
      queue(
        h,
        (body) => {
          // the model answers after the turn listed the tools: the demotion lands before the call
          void setRole('viewer');
          expect((body.tools ?? []).map((t) => t.function?.name)).toContain('make_table');
          return {
            toolCalls: [{ id: 'table_2', name: 'make_table', arguments: { name: 'X' } }],
            delayMs: 300,
          };
        },
        { text: 'Hm.' },
      );
      await h.chat(h.editor, other, 'Make another');
      await h.waitForStatus(h.editor, other, 'idle');
      expect(toolResultOf([h.fake.requests.at(-1)], 'table_2')).toBe(`Error: ${MISSING_SCOPE_MESSAGE}`);
    } finally {
      await setRole('editor');
      tableTarget = null;
    }
  });
});
