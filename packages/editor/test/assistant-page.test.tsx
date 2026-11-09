/**
 * P5-67 (L2): the Assistant page on the demo backend. A message streams and renders (tool row, answer, title),
 * a reload restores the thread, a reconnect of the server stream keeps one copy of the text, markup in a
 * message renders as text, Stop cancels the turn and the thread answers again, rename and delete (with a
 * confirm), a viewer can chat, a waiting card blocks the composer with its reason, and the no-model and off
 * states by role.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector, setAssistantStreamRetry } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { assistantApi } from '../src/api/endpoints';
import { ASSISTANT_EMPTY_TEXT } from '../src/components/assistant/AssistantThreadView';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { ASSISTANT_CARD_WAITING, ASSISTANT_NO_MODEL_TEXT } from '../src/pages/AssistantPage';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp } from './utils';

const WAIT = { timeout: 20_000 };

beforeEach(() => {
  signedIn();
  useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  assistantDemoState(backend()).stepMs = 0;
  setAssistantStreamConnector(demoAssistantStream(backend()));
});

afterEach(() => {
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
  setAssistantStreamRetry(null);
});

async function openPage(path = '/assistant') {
  const utils = renderApp(path);
  const composer = await screen.findByRole('textbox', { name: 'Message' }, WAIT);
  return { ...utils, composer, user: userEvent.setup() };
}

async function send(user: ReturnType<typeof userEvent.setup>, composer: HTMLElement, text: string) {
  await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false), WAIT);
  await user.click(composer);
  await user.type(composer, text.replace(/[{[]/g, '$&$&'));
  await user.keyboard('{Enter}');
}

const chat = () => screen.getByRole('log', { name: 'Assistant chat' });
const requests = (method: string, pattern: RegExp) =>
  backend().requests.filter((r: ApiRequest) => r.method === method && pattern.test(r.path));

describe('Assistant page (P5-67)', () => {
  it('streams a message: the tool row, the answer, the title and the URL', async () => {
    backend().seedWorkflow({ name: 'Order intake' });
    const { composer, user, router } = await openPage();
    expect(screen.getByText(ASSISTANT_EMPTY_TEXT)).toBeTruthy();
    await send(user, composer, 'Show my workflows');
    expect(await screen.findByText(/You have 1 workflow\./, undefined, WAIT)).toBeTruthy();
    const log = chat();
    expect(within(log).getByText('Show my workflows')).toBeTruthy();
    const row = within(log).getByText('list workflows').closest('li');
    expect(row?.getAttribute('data-state')).toBe('done');
    // the composer is free again and the text box empty
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect((composer as HTMLTextAreaElement).value).toBe('');
    const threadId = useAssistantStore.getState().activeThreadId;
    await waitFor(() => expect(router.state.location.pathname).toBe(`/assistant/${threadId}`));
    const list = screen.getByRole('navigation', { name: 'Chats' });
    expect(await within(list).findByText('Show my workflows')).toBeTruthy();
    expect(requests('POST', /^\/assistant\/chat\/[^/]+$/)[0].body).toEqual({ message: 'Show my workflows' });
  });

  it('restores the thread after a reload, each message once', async () => {
    const first = await openPage();
    await send(first.user, first.composer, 'Hello there');
    await screen.findByText(/This is the demo Assistant/, undefined, WAIT);
    const threadId = useAssistantStore.getState().activeThreadId;
    first.unmount();
    useAssistantStore.getState().reset();

    await openPage(`/assistant/${threadId}`);
    expect(await screen.findByText(/This is the demo Assistant/, undefined, WAIT)).toBeTruthy();
    expect(within(chat()).getAllByText('Hello there')).toHaveLength(1);
    expect(within(chat()).getAllByText(/This is the demo Assistant/)).toHaveLength(1);
  });

  it('keeps one copy of the text when the server stream reconnects mid-block', async () => {
    const created = await assistantApi.createThread({});
    setAssistantStreamConnector(null);
    setAssistantStreamRetry({ initialMs: 5, maxMs: 20 });
    const encoder = new TextEncoder();
    const frame = (event: object, id?: number) =>
      encoder.encode(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
    const afterIds: string[] = [];
    server.use(
      http.get('*/rest/assistant/events/:threadId', ({ request }) => {
        afterIds.push(new URL(request.url).searchParams.get('lastEventId') ?? '');
        const first = afterIds.length === 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) {
              controller.enqueue(frame({ type: 'run-start', runId: 'r1', payload: { resumed: false } }, 1));
              controller.enqueue(frame({ type: 'text-delta', runId: 'r1', payload: { text: 'Hello ' } }));
              controller.enqueue(frame({ type: 'text-delta', runId: 'r1', payload: { text: 'wor' } }));
              controller.close();
              return;
            }
            controller.enqueue(frame({ type: 'run-start', runId: 'r1', payload: { resumed: false } }, 1));
            controller.enqueue(
              frame(
                { type: 'text-block', runId: 'r1', payload: { messageId: 'm1', text: 'Hello world' } },
                2,
              ),
            );
            controller.enqueue(
              frame({ type: 'run-finish', runId: 'r1', payload: { status: 'completed' } }, 3),
            );
            request.signal.addEventListener('abort', () => {
              try {
                controller.close();
              } catch {
                // closed already
              }
            });
          },
        });
        return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    await openPage(`/assistant/${created.id}`);
    await waitFor(() => expect(within(chat()).getByText('Hello world')).toBeTruthy(), WAIT);
    expect(within(chat()).getAllByText(/Hello/)).toHaveLength(1);
    expect(afterIds.slice(0, 2)).toEqual(['0', '1']);
    expect(useAssistantStore.getState().streamingText).toBe('');
  });

  it('renders markup in a message as text', async () => {
    const { composer, user, container } = await openPage();
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await send(user, composer, markup);
    await screen.findByText(/This is the demo Assistant/, undefined, WAIT);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(within(chat()).getByText(/<img src=x onerror="alert\(1\)">/)).toBeTruthy();
  });

  it('stops a running turn, and the thread answers again', async () => {
    assistantDemoState(backend()).stepMs = 60_000;
    const { composer, user } = await openPage();
    await send(user, composer, 'Take your time');
    const stop = await screen.findByRole('button', { name: 'Stop' }, WAIT);
    await user.click(stop);
    expect(await screen.findByRole('button', { name: 'Send' }, WAIT)).toBeTruthy();
    expect(requests('POST', /\/cancel$/)).toHaveLength(1);
    await waitFor(() => expect(useAssistantStore.getState().status).toBe('idle'));

    assistantDemoState(backend()).stepMs = 0;
    await send(user, composer, 'Now answer');
    expect(await screen.findByText(/This is the demo Assistant/, undefined, WAIT)).toBeTruthy();
  });

  it('renames and deletes a chat after a confirm', async () => {
    const { composer, user, router } = await openPage();
    await send(user, composer, 'First chat');
    await screen.findByText(/This is the demo Assistant/, undefined, WAIT);
    const list = screen.getByRole('navigation', { name: 'Chats' });
    await user.click(await within(list).findByRole('button', { name: 'Rename First chat' }));
    const field = within(list).getByRole('textbox', { name: 'Chat name' });
    await user.clear(field);
    await user.type(field, 'Renamed chat{Enter}');
    expect(await within(list).findByText('Renamed chat')).toBeTruthy();
    expect(requests('PATCH', /^\/assistant\/threads\/[^/]+$/).map((r) => r.body)).toEqual([
      { title: 'Renamed chat' },
    ]);

    await user.click(within(list).getByRole('button', { name: 'Delete Renamed chat' }));
    const dialog = await screen.findByRole('dialog', undefined, WAIT);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(list).findByText('No chats yet')).toBeTruthy();
    expect(requests('DELETE', /^\/assistant\/threads\/[^/]+$/)).toHaveLength(1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/assistant'));
    expect(await screen.findByText(ASSISTANT_EMPTY_TEXT, undefined, WAIT)).toBeTruthy();
  });

  it('opens a new chat from the list', async () => {
    const { user, router } = await openPage();
    await user.click(await screen.findByRole('button', { name: 'New chat' }, WAIT));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/assistant\/thread-/));
    expect(await screen.findByText(ASSISTANT_EMPTY_TEXT, undefined, WAIT)).toBeTruthy();
    expect(requests('POST', /^\/assistant\/threads$/)).toHaveLength(1);
  });

  it('lets a viewer chat', async () => {
    backend().setDemoRole('viewer');
    const { composer, user } = await openPage();
    await send(user, composer, 'Hi from a viewer');
    expect(await screen.findByText(/This is the demo Assistant/, undefined, WAIT)).toBeTruthy();
  });

  it('blocks the composer with the reason while a card waits', async () => {
    const created = await assistantApi.createThread({});
    const demo = assistantDemoState(backend()).threads.get(created.id);
    demo?.pending.push({
      requestId: 'req-1',
      toolCallId: 'c1',
      toolName: 'delete_workflow',
      title: 'Delete workflow',
      allowSession: false,
      expiresAt: null,
      createdAt: '2026-11-08T00:00:00.000Z',
      inputType: 'approval',
      details: { facts: [] },
    });
    renderApp(`/assistant/${created.id}`);
    expect(await screen.findByText(ASSISTANT_CARD_WAITING, undefined, WAIT)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.querySelector('[data-request-id="req-1"]')).not.toBeNull();
  });

  it.each(['owner', 'admin'] as const)('gives an %s the setup wizard while no model is set', async (role) => {
    backend().setDemoRole(role);
    backend().options.assistant = { enabled: true, modelSet: false };
    renderApp('/assistant');
    expect(await screen.findByRole('region', { name: 'Set up the Assistant' }, WAIT)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_NO_MODEL_TEXT)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it.each(['editor', 'viewer'] as const)('tells an %s that an admin sets the model', async (role) => {
    backend().setDemoRole(role);
    backend().options.assistant = { enabled: true, modelSet: false };
    renderApp('/assistant');
    expect(await screen.findByText(ASSISTANT_NO_MODEL_TEXT, undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Set up the Assistant' })).toBeNull();
  });

  it('says the Assistant is off', async () => {
    backend().options.assistant = { enabled: false, modelSet: true };
    renderApp('/assistant');
    expect(await screen.findByText('The Assistant is off', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });
});
