/**
 * P5-66: the builder's saved chat follows the workflow's versions. A version restore cuts the chat back
 * to the message that produced that version (the later ones go, on the server and in the panel), Accept
 * tags the last message with the saved version, and "Clear chat" empties both. Runs on the mock backend
 * behind MSW (the same `/ai/*` routes the panel calls).
 */
import { act } from '@testing-library/react';
import type { BuilderMessage } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { aiApi } from '../src/api/endpoints';
import { seedDemoAiSession } from '../src/demo/mock-ai';
import {
  clearBuilderSession,
  onDraftAccepted,
  onVersionRestored,
} from '../src/features/builder/session-actions';
import { newId } from '../src/lib/ids';
import { useBuilderStore } from '../src/stores/builder-store';
import { useToastStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';

const message = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  versionId?: string,
): BuilderMessage => ({
  id,
  role,
  text,
  createdAt: '2026-11-08T00:00:00Z',
  ...(versionId ? { versionId } : {}),
});

const CHAT = [
  message('m1', 'user', 'Build a lead flow'),
  message('m2', 'assistant', 'Built it', 'v1'),
  message('m3', 'user', 'Add Slack'),
  message('m4', 'assistant', 'Added Slack', 'v2'),
];

let workflowId: string;

beforeEach(() => {
  signedIn();
  const wf = backend().seedWorkflow({ name: 'Leads', nodes: [], connections: {} });
  workflowId = wf.id;
  seedDemoAiSession(backend(), workflowId, CHAT);
  useBuilderStore.getState().reset();
  act(() => useWorkflowStore.getState().load({ ...wf, name: 'Leads' }));
  act(() => useBuilderStore.getState().setMessages(CHAT));
  useToastStore.setState({ toasts: [] });
});

describe('version restore', () => {
  it('cuts the chat back to the message of the restored version, on the server and in the panel', async () => {
    await onVersionRestored(workflowId, 'v1');
    expect((await aiApi.sessions(workflowId)).messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(useBuilderStore.getState().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    const calls = backend().requests.filter((r) => r.path === '/ai/build/truncate-messages');
    expect(calls.length).toBe(1);
    expect((calls[0].body as { messageId: string }).messageId).toBe('m3');
  });

  it('a version no message names leaves the chat alone', async () => {
    await onVersionRestored(workflowId, 'unknown');
    expect((await aiApi.sessions(workflowId)).messages.length).toBe(4);
    expect(useBuilderStore.getState().messages.length).toBe(4);
    expect(backend().requests.some((r) => r.path === '/ai/build/truncate-messages')).toBe(false);
  });

  it('restoring the newest version removes nothing', async () => {
    await onVersionRestored(workflowId, 'v2');
    expect((await aiApi.sessions(workflowId)).messages.length).toBe(4);
    expect(backend().requests.some((r) => r.path === '/ai/build/truncate-messages')).toBe(false);
  });
});

describe('Accept', () => {
  it('tags the last message with the saved version on the server and in the panel', async () => {
    const extra = [...CHAT, message(newId(), 'user', 'More'), message('m6', 'assistant', 'Done')];
    seedDemoAiSession(backend(), workflowId, extra.slice(4));
    act(() => useBuilderStore.getState().setMessages(extra));
    await onDraftAccepted(workflowId, 'v3');
    const session = await aiApi.sessions(workflowId);
    expect(session.messages.at(-1)?.versionId).toBe('v3');
    expect(session.activeVersionCardId).toBe('m6');
    expect(useBuilderStore.getState().messages.at(-1)?.versionId).toBe('v3');
  });
});

describe('Clear chat', () => {
  it('empties the saved chat and the panel', async () => {
    act(() => useBuilderStore.getState().setQuestions([]));
    await clearBuilderSession(workflowId);
    expect((await aiApi.sessions(workflowId)).messages).toEqual([]);
    expect(useBuilderStore.getState().messages).toEqual([]);
    expect(useBuilderStore.getState().questions).toBeNull();
  });

  it('a failed call keeps the chat and says so', async () => {
    await clearBuilderSession('00000000-0000-4000-8000-000000000000');
    expect(useBuilderStore.getState().messages.length).toBe(4);
    expect(useToastStore.getState().toasts.some((t) => t.title === "Couldn't clear the chat")).toBe(true);
  });
});
