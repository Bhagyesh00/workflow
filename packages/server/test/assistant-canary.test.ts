/**
 * P5-67 (L1): what must never leave the server through the Assistant. A credential secret, a
 * secret-shaped value in a tool result and an environment value never appear in any request body the
 * fake model received, in `assistant_messages` or in `assistant_events`; the second tenant's names, ids
 * and secret never do; an `sk-` key in the user's own text is redacted before the model and the table.
 * And no server source file imports `@workflow/nodes-ai` at run time (types only).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { type AssistantHarness, CANARY, createAssistantHarness } from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';

const ENV_CANARY = 'env-canary-value-7f3a91';
const USER_KEY = 'sk-proj-UserPastedKey0123456789abcdefXYZ';
const RESULT_SECRET = 'ghp_ResultSecretToken0123456789abcdefABCD';
const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

/** a tool whose result holds secret-shaped values and a node parameter with a key */
const leaky: AssistantToolDefinition<Record<string, never>> = {
  name: 'read_settings',
  description: 'Read some settings',
  input: z.object({}),
  minRole: 'viewer',
  async handler() {
    return {
      token: RESULT_SECRET,
      parameters: { authorization: `Bearer ${RESULT_SECRET}`, apiKey: USER_KEY },
      pem: PRIVATE_KEY,
    };
  },
};

function queue(h: AssistantHarness, ...steps: FakeLlmStep[]) {
  while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
  h.script.splice(h.fake.requests.length, 0, ...steps);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('Assistant canaries', () => {
  let h: AssistantHarness;
  let modelKey: string;

  beforeAll(async () => {
    process.env.ASSISTANT_TEST_CANARY = ENV_CANARY;
    h = await createAssistantHarness({ extraTools: [leaky], config: { ASSISTANT_TEST_CANARY: ENV_CANARY } });
    modelKey = 'sk-test-assistant-key-00000000000';
  });
  afterAll(async () => {
    delete process.env.ASSISTANT_TEST_CANARY;
    await h?.close();
  });

  it('keeps secrets, env values and the other tenant out of requests, messages and events', async () => {
    const threadId = await h.createThread(h.owner);
    queue(
      h,
      { toolCalls: [{ id: 'leak_1', name: 'read_settings', arguments: {} }] },
      { text: `Here is what I found. Also ${RESULT_SECRET}` },
    );
    await h.chat(
      h.owner,
      threadId,
      `My key is ${USER_KEY}, keep it safe. Show the workflow "${CANARY.workflow}"`,
    );
    await h.waitForStatus(h.owner, threadId, 'idle');
    queue(h, { text: 'Second answer.' });
    await h.chat(h.owner, threadId, `And the credential ${h.other.credentialId}?`);
    await h.waitForStatus(h.owner, threadId, 'idle');

    const sent = JSON.stringify(h.fake.requests);
    const messages = JSON.stringify(
      (await h.ctx.database.pool.query('select * from assistant_messages where tenant_id = $1', [h.tenantId]))
        .rows,
    );
    const events = JSON.stringify(
      (await h.ctx.database.pool.query('select * from assistant_events where tenant_id = $1', [h.tenantId]))
        .rows,
    );
    const streamed = JSON.stringify(await h.events(h.owner, threadId));
    for (const [where, text] of [
      ['requests', sent],
      ['messages', messages],
      ['events', events],
      ['stream', streamed],
    ] as const) {
      for (const secret of [
        USER_KEY,
        RESULT_SECRET,
        modelKey,
        ENV_CANARY,
        CANARY.secret,
        'BEGIN PRIVATE KEY',
      ]) {
        expect(text, `${secret} in ${where}`).not.toContain(secret);
      }
      for (const value of [
        CANARY.workspace,
        CANARY.credential,
        CANARY.dataTable,
        h.other.tenantId,
        h.other.workflowId,
      ]) {
        expect(text, `${value} in ${where}`).not.toContain(value);
      }
    }
    // the user's key was redacted, not dropped: the rest of the text is there
    expect(sent).toContain('My key is [redacted], keep it safe.');
    expect(messages).toContain('My key is [redacted], keep it safe.');
    // the encryption key and the database password never reach the model
    expect(sent).not.toContain(h.ctx.config.encryptionKeys[0].key.toString('base64'));
    expect(sent).not.toContain('postgres:postgres');
  });

  it('never imports @workflow/nodes-ai at run time in the server sources', () => {
    const root = path.resolve(__dirname, '../src');
    const offenders = sourceFiles(root).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        /^\s*import\s+(?!type\b)[^;]*from\s+['"]@workflow\/nodes-ai['"]/m.test(text) ||
        /\brequire\(\s*['"]@workflow\/nodes-ai['"]\s*\)/.test(text) ||
        /\bimport\(\s*['"]@workflow\/nodes-ai['"]\s*\)/.test(text)
      );
    });
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});
