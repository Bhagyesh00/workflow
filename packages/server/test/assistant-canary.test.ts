/**
 * P5-67 (L1): what must never leave the server through the Assistant. A credential secret, a
 * secret-shaped value in a tool result and an environment value never appear in any request body the
 * fake model received, in `assistant_messages` or in `assistant_events`; the second tenant's names, ids
 * and secret never do; an `sk-` key in the user's own text is redacted before the model and the table.
 * The model calls real built-in read tools (workflows, credentials, data tables, resolved parameters on
 * a node with `$env`, and the other tenant's workflow and table ids), so each check can fail.
 * And no server source file imports `@workflow/nodes-ai` at run time (types only).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import { chain, createWorkflow, node, waitForExecution } from './helpers';

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
  access: 'instanceAi:message',
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
    // a workflow of this tenant whose parameters hold the model credential's key and an `$env` read,
    // run once, so the built-in read tools below have something that could leak
    const envFlow = await createWorkflow(h.owner.client, {
      name: 'Env flow',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Env',
          'core.set',
          {
            mode: 'manual',
            includeOtherFields: false,
            assignments: {
              assignments: [
                { id: 'a1', name: 'canary', value: '={{ $env.ASSISTANT_TEST_CANARY }}', type: 'string' },
              ],
            },
            // read only in raw mode: the run never evaluates it, get_workflow shows it
            jsonOutput: JSON.stringify({ apiKey: modelKey }),
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Env'),
    });
    const { executionId } = await h.owner.client.data<{ executionId: string }>(
      h.owner.client.post(`/rest/workflows/${envFlow.id}/run`, {}),
    );
    await waitForExecution(h.ctx, h.tenantId, executionId);

    const threadId = await h.createThread(h.owner);
    const calls = [
      { id: 'leak_1', name: 'read_settings', arguments: {} },
      { id: 'wf_list', name: 'list_workflows', arguments: {} },
      { id: 'wf_own', name: 'get_workflow', arguments: { workflowId: envFlow.id } },
      { id: 'wf_other', name: 'get_workflow', arguments: { workflowId: h.other.workflowId } },
      { id: 'cred_list', name: 'list_credentials', arguments: {} },
      { id: 'dt_list', name: 'list_data_tables', arguments: {} },
      { id: 'dt_other', name: 'query_data_table_rows', arguments: { dataTableId: h.other.dataTableId } },
      { id: 'resolved', name: 'get_resolved_node_parameters', arguments: { executionId, nodeName: 'Env' } },
    ];
    queue(h, { toolCalls: calls }, { text: `Here is what I found. Also ${RESULT_SECRET}` });
    await h.chat(
      h.owner,
      threadId,
      `My key is ${USER_KEY}, keep it safe. Show the workflow "${CANARY.workflow}"`,
    );
    await h.waitForStatus(h.owner, threadId, 'idle');
    // every call really ran a tool: each has a result, the other tenant's ids are not found
    const results = Object.fromEntries(calls.map((c) => [c.id, toolResultOf(h.fake.requests, c.id) ?? '']));
    for (const call of calls) expect(results[call.id], call.id).not.toBe('');
    for (const id of ['leak_1', 'wf_list', 'wf_own', 'cred_list', 'dt_list', 'resolved']) {
      expect(results[id], id).not.toMatch(/^Error:/);
    }
    expect(results.wf_other).toMatch(/^Error:/);
    expect(results.dt_other).toMatch(/^Error:/);
    expect(results.wf_own).toContain('Env flow');
    expect(results.cred_list).toContain('Assistant model');
    for (const id of ['wf_other', 'dt_other']) expect(results[id]).not.toContain(CANARY.workflow);
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
      // the other tenant's workflow and table ids are in the model's own calls (it asked for them), so
      // they are checked in the results below; its names and tenant id appear nowhere
      for (const value of [CANARY.workspace, CANARY.credential, CANARY.dataTable, h.other.tenantId]) {
        expect(text, `${value} in ${where}`).not.toContain(value);
      }
    }
    for (const call of calls) {
      for (const value of [CANARY.workflow, CANARY.secret, ENV_CANARY, modelKey]) {
        expect(results[call.id], `${value} in ${call.id}`).not.toContain(value);
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
