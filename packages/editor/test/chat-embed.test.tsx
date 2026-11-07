/**
 * P5-59 Embed chat: the button shows only for a public Chat Trigger, the modal holds the production URL in four
 * snippets (script tag, React, Vue, other), no test token anywhere, copy buttons, and the Allowed Origins note.
 */
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHAT_TRIGGER_TYPE, type WorkflowNode } from '@workflow/workflow';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsApi } from '../src/api/endpoints';
import { EmbedModal, embedSnippets } from '../src/components/chat/EmbedModal';
import { LogPanel } from '../src/components/workflow/LogPanel';
import { useChatStore } from '../src/stores/chat-store';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

configure({ asyncUtilTimeout: 20_000 });

const noop = () => undefined;

const chatNode = (parameters: Record<string, unknown>): WorkflowNode => ({
  id: 'Chat',
  name: 'Chat',
  type: CHAT_TRIGGER_TYPE,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  webhookId: 'chat-hook',
});

async function openWith(parameters: Record<string, unknown>) {
  const wf = backend().seedWorkflow({ name: 'Embed', nodes: [chatNode(parameters)], connections: {} });
  useWorkflowStore.getState().load(await workflowsApi.get(wf.id));
  return wf;
}

function renderPanel() {
  const panel = <LogPanel logs={[]} runData={{}} onClear={noop} onClose={noop} onFocusNode={noop} />;
  return withProviders(<RouterProvider router={createMemoryRouter([{ path: '/', element: panel }])} />);
}

beforeEach(() => {
  signedIn();
  useRunStore.getState().reset();
  useChatStore.getState().newSession();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ logPanelTab: 'chat', logPanelOpen: true });
});
afterEach(() => vi.restoreAllMocks());

describe('Embed chat button', () => {
  it('shows only when the Chat Trigger is public', async () => {
    await openWith({ public: false });
    const first = renderPanel();
    await screen.findByRole('button', { name: 'New session' });
    expect(screen.queryByRole('button', { name: 'Embed chat' })).toBeNull();
    first.unmount();

    await openWith({ public: true });
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Embed chat' })).toBeTruthy();
  });

  it('opens the modal with the production URL of the chat', async () => {
    await openWith({ public: true, mode: 'webhook' });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Embed chat' }));

    const dialog = await screen.findByRole('dialog');
    const url = await within(dialog).findAllByText(/\/webhook\/[^/]+\/chat-hook\/chat/);
    expect(url.length).toBeGreaterThan(0);
    for (const title of ['Script tag', 'React', 'Vue', 'Other clients']) {
      expect(within(dialog).getByRole('region', { name: title })).toBeTruthy();
    }
    expect(within(dialog).getAllByText(/Allowed Origins/).length).toBeGreaterThan(0);
  });
});

describe('embed snippets', () => {
  const production = 'https://flows.example.com/webhook/acme/chat-hook/chat';
  const snippets = embedSnippets(production, 'https://flows.example.com');
  const byId = (id: string) => snippets.find((s) => s.id === id)?.code ?? '';

  it('has the four snippets, each with the production URL', () => {
    expect(snippets.map((s) => s.id)).toEqual(['script', 'react', 'vue', 'other']);
    for (const snippet of snippets) expect(snippet.code).toContain(production);
  });

  it('loads the widget from our origin in the script snippet', () => {
    expect(byId('script')).toContain('src="https://flows.example.com/chat-widget/chat.js"');
    expect(byId('script')).toContain('href="https://flows.example.com/chat-widget/chat.css"');
    expect(byId('script')).toContain('WorkflowChat.createChat');
  });

  it('uses the widget global in React and Vue and the URL alone for other clients', () => {
    expect(byId('react')).toContain('window.WorkflowChat.createChat');
    expect(byId('vue')).toContain('window.WorkflowChat.createChat');
    expect(byId('other')).toBe(production);
  });

  it('holds no token or key', () => {
    for (const snippet of snippets) {
      expect(snippet.code).not.toMatch(/x-chat-test-token|demo-chat-test|chatTestToken|apiKey|Bearer/i);
    }
  });

  it('quotes the URL as a JavaScript string', () => {
    const tricky = embedSnippets('https://x.test/webhook/a/b/chat?q="1"', 'https://x.test');
    expect(tricky[0].code).toContain('"https://x.test/webhook/a/b/chat?q=\\"1\\""');
  });
});

describe('EmbedModal', () => {
  it('copies a snippet and says so', async () => {
    const wf = await openWith({ public: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withProviders(<EmbedModal open onClose={noop} workflowId={wf.id} nodeName="Chat" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Copy Other clients snippet' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toMatch(/\/webhook\/[^/]+\/chat-hook\/chat$/);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Other clients copied');
  });

  it('says there is no URL yet when the workflow has none', async () => {
    withProviders(<EmbedModal open onClose={noop} workflowId={undefined} nodeName="Chat" />);
    expect(await screen.findByText('No chat URL yet')).toBeTruthy();
  });

  it('closes with the Close button', async () => {
    const wf = await openWith({ public: true });
    const onClose = vi.fn();
    withProviders(<EmbedModal open onClose={onClose} workflowId={wf.id} nodeName="Chat" />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Close' }))[0]);
    expect(onClose).toHaveBeenCalled();
  });
});
