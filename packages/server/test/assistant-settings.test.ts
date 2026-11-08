/**
 * P5-71 (L8): GET and PATCH /rest/assistant/settings. Admin only; the model must be a chat model node
 * with the workspace's own credential that fits it; a search key is a Brave or SearXNG credential of the
 * workspace; `always_allow` only on the three read keys; a blocked key takes its tool out of the model's
 * tool list; off answers 404 on chat; every change is audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { type AssistantHarness, createAssistantHarness, HARNESS_MODEL } from './fakes/assistant-harness';

const probe: AssistantToolDefinition = {
  name: 'settings_probe',
  description: 'A tool under the tagWorkflow permission (test seam)',
  input: z.object({}),
  minRole: 'viewer',
  permission: 'tagWorkflow',
  async handler() {
    return { ok: true };
  },
};

interface SettingsBody {
  enabled: boolean;
  credentialId: string | null;
  nodeType: string | null;
  model: string | null;
  modelSet: boolean;
  searchCredentialId: string | null;
  searchDisabled: boolean;
  mcpAccessEnabled: boolean;
  permissions: Record<string, string>;
  allowSendingParameterValues: boolean;
  instanceAllowsSendingParameterValues: boolean;
}

let h: AssistantHarness;
let braveId: string;
let searxId: string;
let openAiId: string;

const get = (user = h.admin) => user.client.get('/rest/assistant/settings');
const patch = (body: unknown, user = h.admin) => user.client.patch('/rest/assistant/settings', body);
const settingsOf = async (user = h.admin) => user.client.data<SettingsBody>(get(user));
const toolNames = (index: number): string[] => {
  const request = h.fake.requests[index] as { tools?: Array<{ function: { name: string } }> };
  return (request.tools ?? []).map((tool) => tool.function.name);
};

async function credential(type: string, data: Record<string, unknown>, user = h.owner) {
  const created = await user.client.data<{ id: string }>(
    user.client.post('/rest/credentials', { name: `${type} ${Math.random().toString(36).slice(2, 8)}`, type, data }),
  );
  return created.id;
}

beforeAll(async () => {
  h = await createAssistantHarness({
    script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
    extraTools: [probe],
  });
  braveId = await credential('braveSearchApi', { apiKey: 'brave-key-1' });
  searxId = await credential('searXngApi', { apiUrl: 'https://searx.example.com' });
  openAiId = await credential('openAiApi', { apiKey: 'sk-test-second', baseUrl: h.fake.baseUrl });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('who may use the route', () => {
  it('lets the owner and an admin read and write; an editor and a viewer get 403', async () => {
    for (const user of [h.owner, h.admin]) {
      expect((await get(user)).statusCode).toBe(200);
      expect((await patch({ allowSendingParameterValues: true }, user)).statusCode).toBe(200);
    }
    for (const user of [h.editor, h.viewer]) {
      expect((await get(user)).statusCode).toBe(403);
      expect((await patch({ enabled: false }, user)).statusCode).toBe(403);
    }
    expect((await settingsOf()).enabled).toBe(true);
  });

  it('answers 401 signed out', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/rest/assistant/settings' });
    expect(response.statusCode).toBe(401);
  });

  it('shows credential ids to an admin, and never in the public settings', async () => {
    const body = await settingsOf();
    expect(body.credentialId).toBe(h.modelCredentialId);
    expect(body.nodeType).toBe(HARNESS_MODEL.nodeType);
    expect(body.model).toBe(HARNESS_MODEL.model);
    expect(body.modelSet).toBe(true);
    expect(Object.keys(body.permissions)).toHaveLength(22);
    const everyone = await h.viewer.client.get('/rest/settings');
    expect(everyone.body).not.toContain(h.modelCredentialId);
    expect(everyone.body).toContain('"assistant":{"enabled":true,"modelSet":true}');
  });
});

describe('the model', () => {
  it('saves a chat model, its credential and a model id, and audits the change', async () => {
    const response = await patch({ credentialId: openAiId, nodeType: 'ai.lmChatOpenAi', model: ' gpt-4o ' });
    expect(response.statusCode).toBe(200);
    const body = await h.admin.client.data<SettingsBody>(Promise.resolve(response));
    expect(body).toMatchObject({ credentialId: openAiId, model: 'gpt-4o', modelSet: true });
    const rows = await h.ctx.repos.audit.list(h.tenantId, 50);
    const row = rows.find((r) => r.action === 'tenant.settings_updated' && JSON.stringify(r.metadata).includes('model'));
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('gpt-4o');
    await patch({ credentialId: h.modelCredentialId, model: HARNESS_MODEL.model });
  });

  it('refuses another workspace credential and a missing one', async () => {
    for (const id of [h.other.credentialId, 'does-not-exist']) {
      const response = await patch({ credentialId: id });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('sk-canary');
    }
    expect((await settingsOf()).credentialId).toBe(h.modelCredentialId);
  });

  it('refuses a node type that is not a chat model, and a credential that does not fit the node', async () => {
    const notChat = await patch({ nodeType: 'core.manualTrigger' });
    expect(notChat.statusCode).toBe(400);
    expect(notChat.body).toContain('not a chat model node type');
    const mismatch = await patch({ credentialId: braveId });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain("doesn't fit the chosen model");
    const after = await settingsOf();
    expect([after.credentialId, after.nodeType]).toEqual([h.modelCredentialId, HARNESS_MODEL.nodeType]);
  });

  it('shows members the Assistant link flag only once a model is set', async () => {
    const featureOf = async () =>
      (await h.viewer.client.data<{ features: { assistant: unknown } }>(h.viewer.client.get('/rest/settings')))
        .features.assistant;
    expect(await featureOf()).toEqual({ enabled: true, modelSet: true });
    expect((await patch({ credentialId: null })).statusCode).toBe(200);
    expect((await settingsOf()).modelSet).toBe(false);
    expect(await featureOf()).toEqual({ enabled: true, modelSet: false });
    expect((await patch({ credentialId: h.modelCredentialId })).statusCode).toBe(200);
    expect(await featureOf()).toEqual({ enabled: true, modelSet: true });
  });
});

describe('web search', () => {
  it('takes a Brave or SearXNG credential of the workspace', async () => {
    for (const id of [braveId, searxId]) {
      const body = await h.admin.client.data<SettingsBody>(patch({ searchCredentialId: id }));
      expect([body.searchCredentialId, body.searchDisabled]).toEqual([id, false]);
    }
  });

  it('refuses a credential of another type, another workspace, or none', async () => {
    const before = (await settingsOf()).searchCredentialId;
    const otherBrave = await credential('braveSearchApi', { apiKey: 'brave-other' }, h.other.owner);
    for (const id of [openAiId, otherBrave, h.other.credentialId, 'nope']) {
      expect((await patch({ searchCredentialId: id })).statusCode).toBe(400);
    }
    expect((await settingsOf()).searchCredentialId).toBe(before);
  });

  it('turns search off (the wizard Skip) and clears the key; a key turns it on again', async () => {
    const off = await h.admin.client.data<SettingsBody>(patch({ searchDisabled: true }));
    expect([off.searchDisabled, off.searchCredentialId]).toEqual([true, null]);
    expect((await patch({ searchDisabled: true, searchCredentialId: braveId })).statusCode).toBe(400);
    const on = await h.admin.client.data<SettingsBody>(patch({ searchCredentialId: braveId }));
    expect([on.searchDisabled, on.searchCredentialId]).toEqual([false, braveId]);
  });
});

describe('permissions', () => {
  it('refuses always_allow outside the three read keys with 400', async () => {
    for (const key of ['runWorkflow', 'createWorkflow', 'mcpWrite', 'executeNode']) {
      const response = await patch({ permissions: { [key]: 'always_allow' } });
      expect(response.statusCode).toBe(400);
    }
    expect((await settingsOf()).permissions.runWorkflow).toBe('require_approval');
  });

  it('allows always_allow on fetchUrl, webSearch and mcpRead, and blocked anywhere', async () => {
    const body = await h.admin.client.data<SettingsBody>(
      patch({ permissions: { fetchUrl: 'always_allow', webSearch: 'always_allow', mcpRead: 'always_allow', runWorkflow: 'blocked' } }),
    );
    expect(body.permissions).toMatchObject({
      fetchUrl: 'always_allow',
      webSearch: 'always_allow',
      mcpRead: 'always_allow',
      runWorkflow: 'blocked',
      createWorkflow: 'require_approval',
    });
    await patch({ permissions: { runWorkflow: 'require_approval' } });
  });

  it('refuses an unknown permission, an unknown mode and an unknown field', async () => {
    expect((await patch({ permissions: { deleteEverything: 'blocked' } })).statusCode).toBe(400);
    expect((await patch({ permissions: { runWorkflow: 'sometimes' } })).statusCode).toBe(400);
    expect((await patch({ sandbox: true })).statusCode).toBe(400);
  });

  it('takes a blocked key out of the tool list the model gets', async () => {
    const thread = await h.createThread(h.editor);
    await h.chat(h.editor, thread, 'hello');
    await h.waitForStatus(h.editor, thread, 'idle');
    expect(toolNames(h.fake.requests.length - 1)).toContain('settings_probe');

    expect((await patch({ permissions: { tagWorkflow: 'blocked' } })).statusCode).toBe(200);
    const second = await h.createThread(h.editor);
    await h.chat(h.editor, second, 'hello again');
    await h.waitForStatus(h.editor, second, 'idle');
    expect(toolNames(h.fake.requests.length - 1)).not.toContain('settings_probe');
    await patch({ permissions: { tagWorkflow: 'require_approval' } });
    h.checkRequests();
  });
});

describe('on and off, and the other switches', () => {
  it('saves MCP access and the parameter value switch', async () => {
    const body = await h.admin.client.data<SettingsBody>(
      patch({ mcpAccessEnabled: true, allowSendingParameterValues: false }),
    );
    expect([body.mcpAccessEnabled, body.allowSendingParameterValues]).toEqual([true, false]);
    expect(body.instanceAllowsSendingParameterValues).toBe(true);
    await patch({ mcpAccessEnabled: false, allowSendingParameterValues: true });
  });

  it('answers 404 on chat while off, keeps the settings route open, and works again when on', async () => {
    expect((await patch({ enabled: false })).statusCode).toBe(200);
    expect((await h.viewer.client.get('/rest/assistant/threads')).statusCode).toBe(404);
    const chat = await h.editor.client.post('/rest/assistant/chat/anything', { message: 'hi' });
    expect(chat.statusCode).toBe(404);
    const body = await settingsOf();
    expect([body.enabled, body.modelSet]).toEqual([false, true]);
    expect((await patch({ enabled: true })).statusCode).toBe(200);
    expect((await h.viewer.client.get('/rest/assistant/threads')).statusCode).toBe(200);
  });

  it('keeps the other workspace untouched', async () => {
    const other = await h.other.owner.client.get('/rest/assistant/settings');
    expect(other.statusCode).toBe(200);
    expect(other.body).not.toContain(h.modelCredentialId);
    h.expectNoCanary();
  });
});
