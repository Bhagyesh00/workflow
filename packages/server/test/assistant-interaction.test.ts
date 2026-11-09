/**
 * P5-69 (L6): the Assistant's interaction tools through the whole path (chat, run loop, approvals). `ask_user`
 * shows a questions card with filled ids, waits, resumes with the answers; a dismissal or only skipped
 * questions give `answered: false`; two questions with one id are refused before a card. `update_tasks`
 * saves the checklist on the thread and sends `tasks-update`. `setup_credentials` shows a credential card
 * for the type; the answer gives id, name and type only, and another workspace's id or another type is
 * refused.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantConfirmAnswer, AssistantConfirmation, DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import { waitFor } from './helpers';

function queue(h: AssistantHarness, ...steps: FakeLlmStep[]) {
  // the fake reads by request count: fill the places of requests already made (provider retries)
  while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
  h.script.splice(h.fake.requests.length, 0, ...steps);
}

/** the latest result the model read for `toolCallId` */
function lastResult(h: AssistantHarness, toolCallId: string): string | undefined {
  for (let i = h.fake.requests.length - 1; i >= 0; i--) {
    const found = toolResultOf([h.fake.requests[i]], toolCallId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** the model calls `name(args)` once in a new thread of `user`; waits until the run stops or waits */
async function turn(h: AssistantHarness, user: HarnessUser, name: string, args: DataObject) {
  const toolCallId = `${name}_${randomUUID().slice(0, 8)}`;
  const threadId = await h.createThread(user);
  queue(h, { toolCalls: [{ id: toolCallId, name, arguments: args }] }, { text: 'Done.' });
  await h.chat(user, threadId, `Call ${name}`);
  const status = await h.waitForStatus(user, threadId, (s) => !s.hasActiveRun);
  return { threadId, toolCallId, status, result: lastResult(h, toolCallId) };
}

/** answers the card and waits for the resumed turn to end */
async function answer(
  h: AssistantHarness,
  user: HarnessUser,
  threadId: string,
  card: AssistantConfirmation,
  body: AssistantConfirmAnswer,
) {
  const before = h.fake.requests.length;
  const res = await h.confirm(user, card.requestId, body);
  expect(res.statusCode).toBe(200);
  await waitFor(async () => h.fake.requests.length > before, {
    timeout: 15_000,
    message: 'the resumed turn',
  });
  await h.waitForStatus(user, threadId, 'idle');
  return lastResult(h, card.toolCallId);
}

describe('Assistant interaction tools (P5-69)', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('offers each tool from its minimum role', async () => {
    await h.expectToolRoles({
      ask_user: 'instanceAi:message',
      update_tasks: 'instanceAi:message',
      setup_credentials: 'credential:create',
    });
  });

  describe('ask_user', () => {
    const questions = [
      { question: 'Which channel?', type: 'single', options: ['#sales', '#ops'] },
      { id: 'q1', question: 'Which days?', type: 'multi', options: ['Mon', 'Tue', 'Wed'] },
      { question: 'Any note?', type: 'text' },
    ];

    it('waits on a card with filled ids, then resumes with the answers', async () => {
      const { threadId, status, result } = await turn(h, h.viewer, 'ask_user', {
        introMessage: 'Before I build it',
        questions,
      });
      // the turn stops at the card: the model has read nothing yet
      expect(result).toBeUndefined();
      expect(status.isSuspended).toBe(true);
      const card = status.pending[0] as Extract<AssistantConfirmation, { inputType: 'questions' }>;
      expect(card.inputType).toBe('questions');
      expect(card.allowSession).toBe(false);
      // `q1` is taken by the second question, so the first gets the next free id
      expect(card.details).toEqual({
        introMessage: 'Before I build it',
        questions: [
          { id: 'q2', question: 'Which channel?', type: 'single', options: ['#sales', '#ops'] },
          { id: 'q1', question: 'Which days?', type: 'multi', options: ['Mon', 'Tue', 'Wed'] },
          { id: 'q3', question: 'Any note?', type: 'text' },
        ],
      });

      const text = await answer(h, h.viewer, threadId, card, {
        kind: 'questions',
        answers: [
          { id: 'q2', answer: '#ops' },
          { id: 'q1', answer: ['Mon', 'Wed'] },
          { id: 'q3', answer: '' },
          { id: 'q9', answer: 'not a question' },
        ],
      });
      expect(JSON.parse(text ?? '')).toEqual({
        answered: true,
        answers: [
          { questionId: 'q2', question: 'Which channel?', answer: '#ops' },
          { questionId: 'q1', question: 'Which days?', answer: ['Mon', 'Wed'] },
          { questionId: 'q3', question: 'Any note?', answer: null, skipped: true },
        ],
        note: expect.stringContaining('not a yes'),
      });
    });

    it('a dismissal or only skipped questions give answered false', async () => {
      const first = await turn(h, h.viewer, 'ask_user', { questions });
      expect(
        await answer(h, h.viewer, first.threadId, first.status.pending[0], {
          kind: 'questions',
          answers: [{ id: 'q2', answer: '#ops' }],
          dismissed: true,
        }),
      ).toBe('{"answered":false}');

      const second = await turn(h, h.viewer, 'ask_user', { questions });
      expect(
        await answer(h, h.viewer, second.threadId, second.status.pending[0], {
          kind: 'questions',
          answers: [
            { id: 'q1', answer: [] },
            { id: 'q2', answer: null },
          ],
        }),
      ).toBe('{"answered":false}');
    });

    it('refuses two questions with one id before any card', async () => {
      const { status, result } = await turn(h, h.viewer, 'ask_user', {
        questions: [
          { id: 'same', question: 'A?', type: 'text' },
          { id: 'same', question: 'B?', type: 'text' },
        ],
      });
      expect(status.pending).toEqual([]);
      expect(result).toMatch(/^Error: [\s\S]*own id/);
    });

    it('refuses a single question without options', async () => {
      const { status, result } = await turn(h, h.viewer, 'ask_user', {
        questions: [{ question: 'Pick', type: 'single' }],
      });
      expect(status.pending).toEqual([]);
      expect(result).toMatch(/^Error: Invalid arguments/);
    });
  });

  describe('update_tasks', () => {
    it('saves the checklist on the thread and sends tasks-update', async () => {
      const tasks = [
        { id: 't1', description: 'Read the sheet', status: 'done' },
        { id: 't2', description: 'Build the workflow', status: 'in_progress', detail: 'two nodes left' },
        { id: 't3', description: 'Test it', status: 'todo' },
      ];
      const { threadId, result } = await turn(h, h.viewer, 'update_tasks', { tasks });
      expect(result).toBe('{"saved":true}');
      const thread = await h.ctx.repos.assistantThreads.get(h.tenantId, h.viewer.userId, threadId);
      expect(thread?.tasks).toEqual(tasks);
      const events = await h.events(h.viewer, threadId);
      const update = events.find((e) => e.type === 'tasks-update');
      expect(update?.payload).toEqual({ tasks });
      expect(update?.id).toEqual(expect.any(Number));
    });

    it('refuses an empty description and an unknown status', async () => {
      const blank = await turn(h, h.viewer, 'update_tasks', {
        tasks: [{ id: 't1', description: '  ', status: 'todo' }],
      });
      expect(blank.result).toMatch(/^Error: Invalid arguments/);
      const status = await turn(h, h.viewer, 'update_tasks', {
        tasks: [{ id: 't1', description: 'Do it', status: 'pending' }],
      });
      expect(status.result).toMatch(/^Error: Invalid arguments/);
    });
  });

  describe('setup_credentials', () => {
    it('shows a credential card and gives id, name and type of the picked credential only', async () => {
      const { threadId, status } = await turn(h, h.editor, 'setup_credentials', {
        credentialType: 'openAiApi',
        reason: 'The agent needs a model',
      });
      const card = status.pending[0] as Extract<AssistantConfirmation, { inputType: 'credential' }>;
      expect(card).toMatchObject({
        inputType: 'credential',
        title: 'Set up a credential',
        allowSession: false,
        details: { credentialType: 'openAiApi', reason: 'The agent needs a model' },
      });
      expect(card.details.displayName).toEqual(expect.any(String));
      const text = await answer(h, h.editor, threadId, card, {
        kind: 'credential',
        credentialId: h.modelCredentialId,
      });
      expect(text).toContain('<untrusted_data source="credential">');
      expect(text).toContain(`"id":"${h.modelCredentialId}"`);
      expect(text).toContain('"name":"Assistant model"');
      expect(text).toContain('"type":"openAiApi"');
      // never the credential's data
      expect(text).not.toContain('sk-test-assistant-key');
      expect(text).not.toContain('baseUrl');
    });

    it("refuses another workspace's credential and one of another type", async () => {
      const first = await turn(h, h.editor, 'setup_credentials', { credentialType: 'openAiApi' });
      const other = await answer(h, h.editor, first.threadId, first.status.pending[0], {
        kind: 'credential',
        credentialId: h.other.credentialId,
      });
      expect(other).toMatch(/^Error: [\s\S]*not a "openAiApi" credential of this workspace/);
      expect(other).not.toContain(CANARY.credential);

      const second = await turn(h, h.editor, 'setup_credentials', { credentialType: 'slackApi' });
      const wrongType = await answer(h, h.editor, second.threadId, second.status.pending[0], {
        kind: 'credential',
        credentialId: h.modelCredentialId,
      });
      expect(wrongType).toMatch(/^Error: [\s\S]*not a "slackApi" credential/);
      h.expectNoCanary();
    });

    it('none picked gives completed false; an unknown type is refused before a card', async () => {
      const first = await turn(h, h.editor, 'setup_credentials', { credentialType: 'openAiApi' });
      const none = await answer(h, h.editor, first.threadId, first.status.pending[0], {
        kind: 'credential',
        credentialId: null,
      });
      expect(
        JSON.parse(none?.replace(/^<untrusted_data[^>]*>\n|\n<\/untrusted_data>$/g, '') ?? ''),
      ).toMatchObject({
        completed: false,
        credentialType: 'openAiApi',
      });

      const unknown = await turn(h, h.editor, 'setup_credentials', { credentialType: 'noSuchApi' });
      expect(unknown.status.pending).toEqual([]);
      // an untrusted tool's error comes back wrapped like its result (tool-adapter's shapeToolError)
      expect(unknown.result).toMatch(
        /^Error: (?:<untrusted_data source="[^"]+">\n)?There is no credential type "noSuchApi"/,
      );
    });
  });
});
