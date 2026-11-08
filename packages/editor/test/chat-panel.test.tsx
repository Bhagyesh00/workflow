/**
 * P5-59 canvas chat: the Chat tab (tab only with a chat trigger, no request on mount), a send (listen, then POST to
 * the path of the test URL with the token header, streamed or plain reply, the run adopted), new session, a step run
 * below the trigger (opens the chat, remembers the destination), a failed listen, the read only panel, and the
 * "Open chat" button of the execute bar.
 */
import { act, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHAT_TEST_HEADER, CHAT_TRIGGER_TYPE, type TaskData, type WorkflowNode } from '@workflow/workflow';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setChatFetch } from '../src/api/chat-transport';
import { workflowsApi } from '../src/api/endpoints';
import { LogPanel } from '../src/components/workflow/LogPanel';
import { demoNodeTypes } from '../src/demo/fixtures';
import { demoChatFetch } from '../src/demo/mock-chat';
import { storedChatMessages } from '../src/features/editor/chat-actions';
import { ExecuteBar } from '../src/features/editor/ExecuteBar';
import { runWorkflow, webhookTriggerToListen } from '../src/features/editor/editor-actions';
import { useChatStore } from '../src/stores/chat-store';
import { useRunStore } from '../src/stores/run-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

configure({ asyncUtilTimeout: 20_000 });

const description = (name: string) => demoNodeTypes.find((d) => d.name === name);
const deps = { navigate: vi.fn(), descriptions: { get: description } };

const nodeOf = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
  x = 0,
): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [x, 0],
  parameters,
  ...extra,
});

const main = (from: string, to: string) => ({
  [from]: { main: [[{ node: to, type: 'main' as const, index: 0 }]] },
});

const noop = () => undefined;
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let unsubscribe: (() => void) | undefined;
let chatCalls: ReturnType<typeof vi.fn>;

async function open(options: { chatOptions?: Record<string, unknown>; readOnly?: boolean } = {}) {
  const wf = backend().seedWorkflow({
    name: 'Support chat',
    nodes: [
      nodeOf('Chat', CHAT_TRIGGER_TYPE, { options: options.chatOptions ?? {} }, { webhookId: 'chat-hook' }),
      nodeOf('Reply', 'ai.chat', { message: 'Thanks for asking' }, {}, 300),
      nodeOf('After', 'core.noOp', {}, {}, 600),
    ],
    connections: { ...main('Chat', 'Reply'), ...main('Reply', 'After') },
  });
  useWorkflowStore.getState().load(await workflowsApi.get(wf.id), { readOnly: options.readOnly });
  // what the push bridge does in the app
  unsubscribe = backend().subscribe((event) => useRunStore.getState().receive(event, wf.id));
  return wf;
}

function renderPanel() {
  const panel = <LogPanel logs={[]} runData={{}} onClear={noop} onClose={noop} onFocusNode={noop} />;
  return withProviders(<RouterProvider router={createMemoryRouter([{ path: '/', element: panel }])} />);
}

const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;

async function send(text: string) {
  const area = textarea();
  await act(async () => {
    area.value = text;
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
  });
}

const listenCalls = () =>
  backend().requests.filter((r) => r.method === 'POST' && r.path.endsWith('/listen-test-webhook'));

beforeEach(() => {
  signedIn();
  useRunStore.getState().reset();
  useChatStore.getState().newSession();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ logPanelTab: 'chat', logPanelOpen: true });
  chatCalls = vi.fn(demoChatFetch(backend()));
  setChatFetch(chatCalls as unknown as typeof fetch);
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  setChatFetch(null);
  vi.restoreAllMocks();
  useRunStore.getState().reset();
});

describe('Chat tab', () => {
  it('has a Chat tab only with a chat trigger', async () => {
    act(() =>
      useWorkflowStore
        .getState()
        .load({ name: 'Plain', nodes: [nodeOf('M', 'core.manualTrigger')], connections: {} }),
    );
    const { unmount } = renderPanel();
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    unmount();

    await open();
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy();
  });

  it('mounting the panel makes no request', async () => {
    await open();
    const before = backend().requests.length;
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await flush(50);
    expect(chatCalls).not.toHaveBeenCalled();
    expect(listenCalls()).toHaveLength(0);
    expect(
      backend()
        .requests.slice(before)
        .filter((r) => r.path.includes('webhook')),
    ).toEqual([]);
  });
});

describe('a message', () => {
  it('listens, posts to the path of the test URL with the token header, shows the reply and adopts the run', async () => {
    const wf = await open();
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await send('Where is my order?');

    expect(await screen.findByText('Thanks for asking')).toBeTruthy();
    expect(listenCalls()).toHaveLength(1);
    expect(listenCalls()[0].body).toEqual({ nodeName: 'Chat' });

    expect(chatCalls).toHaveBeenCalledTimes(1);
    const [url, init] = chatCalls.mock.calls[0] as [string, RequestInit];
    // the path only, so the POST stays on the page's origin
    expect(url).toMatch(/^\/webhook-test\/[^/]+\/chat-hook\/chat$/);
    const token = (init.headers as Record<string, string>)[CHAT_TEST_HEADER];
    expect(token).toMatch(/^demo-chat-test-/);
    expect(JSON.parse(String(init.body))).toMatchObject({ chatInput: 'Where is my order?' });

    // the run is the canvas run now
    await waitFor(() => expect(useRunStore.getState().executionId).toEqual(expect.any(String)));
    expect(useRunStore.getState().workflowId).toBe(wf.id);
    expect(useRunStore.getState().status).not.toBe('listening');
    // the store keeps the conversation for the next mount
    expect(useChatStore.getState().messages.map((m) => [m.sender, m.text])).toEqual([
      ['user', 'Where is my order?'],
      ['bot', 'Thanks for asking'],
    ]);
  });

  it('renders a streamed reply', async () => {
    await open({ chatOptions: { responseMode: 'streaming' } });
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await send('Stream it');
    expect(await screen.findByText('Thanks for asking')).toBeTruthy();
    expect(useRunStore.getState().executionId).toEqual(expect.any(String));
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(2));
  });

  it('sends one listen per message', async () => {
    await open();
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await send('one');
    await screen.findByText('Thanks for asking');
    await waitFor(() => expect(useRunStore.getState().status).not.toBe('running'));
    await act(async () => {
      useRunStore.getState().reset();
    });
    await send('two');
    await waitFor(() => expect(chatCalls).toHaveBeenCalledTimes(2));
    expect(listenCalls()).toHaveLength(2);
    const tokens = chatCalls.mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)[CHAT_TEST_HEADER],
    );
    expect(new Set(tokens).size).toBe(2);
  });

  it('shows the error and keeps the typed text when the listen fails', async () => {
    await open();
    vi.spyOn(workflowsApi, 'listenTestWebhook').mockRejectedValue(new Error('The test URL is taken'));
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await send('Keep me');

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.description)).toContain('The test URL is taken'),
    );
    expect(chatCalls).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea().value).toBe('Keep me'));
    expect(useRunStore.getState().status).toBe('idle');
    expect(useChatStore.getState().messages).toEqual([]);
  });
});

describe('new session', () => {
  it('clears the messages and the run and starts another session id', async () => {
    await open();
    renderPanel();
    await screen.findByLabelText('Type your question...');
    await send('Hello');
    await screen.findByText('Thanks for asking');
    await waitFor(() => expect(useRunStore.getState().executionId).not.toBeNull());
    const first = useChatStore.getState().sessionId;

    await userEvent.click(screen.getByRole('button', { name: 'New session' }));

    expect(useChatStore.getState().sessionId).not.toBe(first);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useRunStore.getState().executionId).toBeNull();
    expect(screen.queryByText('Thanks for asking')).toBeNull();
    // the next message carries the new session id
    await send('Again');
    await waitFor(() => expect(chatCalls).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String((chatCalls.mock.calls[1][1] as RequestInit).body));
    expect(body.sessionId).toBe(useChatStore.getState().sessionId);
  });

  it('shows a short session id with a copy button', async () => {
    await open();
    renderPanel();
    const id = useChatStore.getState().sessionId;
    expect(screen.getByText(`${id.slice(0, 8)}...`)).toBeTruthy();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByRole('button', { name: 'Copy session id' }));
    expect(writeText).toHaveBeenCalledWith(id);
  });
});

describe('running from the canvas', () => {
  it('Execute workflow on a chat workflow opens the chat tab and runs nothing', async () => {
    await open();
    useUiStore.setState({ logPanelTab: 'logs', logPanelOpen: false });
    await runWorkflow(deps);
    expect(useUiStore.getState().logPanelTab).toBe('chat');
    expect(useUiStore.getState().logPanelOpen).toBe(true);
    expect(listenCalls()).toHaveLength(0);
    expect(backend().requests.filter((r) => r.path.endsWith('/run'))).toEqual([]);
    expect(useRunStore.getState().status).toBe('idle');
  });

  it('a step run below the trigger opens the chat and remembers the destination, and a message sends it', async () => {
    await open();
    useUiStore.setState({ logPanelTab: 'logs', logPanelOpen: false });
    await runWorkflow(deps, { destinationNode: 'After' });
    expect(useUiStore.getState().logPanelTab).toBe('chat');
    expect(useChatStore.getState().destinationNode).toBe('After');
    expect(backend().requests.filter((r) => r.path.endsWith('/run'))).toEqual([]);

    renderPanel();
    expect(screen.getByText('Runs up to After')).toBeTruthy();
    await send('Run to After');
    await waitFor(() => expect(listenCalls()).toHaveLength(1));
    expect(listenCalls()[0].body).toEqual({ nodeName: 'Chat', destinationNode: 'After' });
    await screen.findByText('Thanks for asking');
  });

  it('a step run with the trigger pinned runs as usual', async () => {
    const wf = await open();
    useWorkflowStore.setState({
      pinData: { Chat: [{ json: { chatInput: 'pinned', sessionId: 's' } }] },
    });
    useUiStore.setState({ logPanelTab: 'logs' });
    await runWorkflow(deps, { destinationNode: 'After' });
    expect(useUiStore.getState().logPanelTab).toBe('logs');
    expect(backend().requests.filter((r) => r.path.endsWith('/run')).length).toBeGreaterThan(0);
    expect(wf.id).toBeTruthy();
  });
});

describe('ExecuteBar', () => {
  it('says Open chat instead of Listen for test event for a chat trigger, and opens the chat tab', async () => {
    await open();
    useUiStore.setState({ logPanelTab: 'logs', logPanelOpen: false });
    withProviders(
      <ExecuteBar
        onExecute={() => void runWorkflow(deps)}
        onStop={noop}
        readOnly={false}
        listenNode={webhookTriggerToListen(deps)}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Listen for test event' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(useUiStore.getState().logPanelTab).toBe('chat');
    expect(useUiStore.getState().logPanelOpen).toBe(true);
  });

  it('keeps Open chat enabled for a role that cannot run', async () => {
    await open({ readOnly: true });
    withProviders(<ExecuteBar onExecute={noop} onStop={noop} readOnly listenNode="Chat" />);
    expect((screen.getByRole('button', { name: 'Open chat' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('read only', () => {
  const task = (json: Record<string, unknown>, startTime: number): TaskData => ({
    startTime,
    executionTime: 1,
    executionStatus: 'success',
    data: { main: [[{ json }]] },
    source: [],
  });

  it('shows the stored messages of the execution on screen and has no input', async () => {
    await open({ readOnly: true });
    useRunStore.setState({
      runData: {
        Chat: [task({ chatInput: 'What did I order?', sessionId: 's' }, 1)],
        Reply: [task({ message: 'A blue lamp' }, 2)],
      },
    });
    renderPanel();
    expect(await screen.findByText('What did I order?')).toBeTruthy();
    expect(screen.getByText('A blue lamp')).toBeTruthy();
    expect(textarea()).toBeNull();
    expect(chatCalls).not.toHaveBeenCalled();
  });

  it('says so when nothing is stored', async () => {
    await open({ readOnly: true });
    renderPanel();
    expect(await screen.findByText('Chat is read only')).toBeTruthy();
  });

  it('reads the last node output when no Respond to Chat node ran', () => {
    const nodes = [nodeOf('Chat', CHAT_TRIGGER_TYPE), nodeOf('Agent', 'ai.agent')];
    const lines = storedChatMessages(
      { Chat: [task({ chatInput: 'Hi' }, 1)], Agent: [task({ output: 'Hello there' }, 5)] },
      nodes,
    );
    expect(lines.map((l) => [l.sender, l.text])).toEqual([
      ['user', 'Hi'],
      ['bot', 'Hello there'],
    ]);
  });
});

describe('opening another workflow', () => {
  it('starts a new chat session and drops the messages and the step run destination', async () => {
    const chatWorkflow = (name: string) =>
      backend().seedWorkflow({
        name,
        nodes: [nodeOf('Chat', CHAT_TRIGGER_TYPE, {}, { webhookId: `hook-${name}` })],
        connections: {},
      });
    const a = chatWorkflow('Chat A');
    const b = chatWorkflow('Chat B');
    const { router } = renderApp(`/workflow/${a.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    const before = useChatStore.getState().sessionId;
    act(() => {
      useChatStore.getState().addMessage('user', 'hello from A');
      useChatStore.getState().setDestination('Agent');
      useChatStore.getState().markSent();
    });
    await act(async () => {
      await router.navigate(`/workflow/${b.id}`);
    });
    await waitFor(() => expect(useWorkflowStore.getState().meta.id).toBe(b.id));
    const chat = useChatStore.getState();
    expect(chat.sessionId).not.toBe(before);
    expect(chat.messages).toEqual([]);
    expect(chat.destinationNode).toBeNull();
    expect(chat.hasSent).toBe(false);
  });
});
