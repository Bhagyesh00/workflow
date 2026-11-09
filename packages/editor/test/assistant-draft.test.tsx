/**
 * P5-70 (L7): the draft card. It loads the draft from its reference and shows the name, the node count and the
 * diff, where a changed URL shows its old and new value; Accept saves the workflow on the draft's base version
 * and offers Open; Discard saves nothing; a stale base stays in the card with the server's reason and a link to
 * the workflow; a viewer sees why the buttons are off; names stay text; on the page, the draft's artifact shows
 * the card in the thread.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssistantDraftDTO, WorkflowNode } from '@workflow/workflow';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { assistantApi, workflowsApi } from '../src/api/endpoints';
import { DRAFT_VIEWER_REASON, DraftCard } from '../src/components/assistant/DraftCard';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { addDemoDraft } from '../src/demo/mock-assistant-drafts';
import { useAssistantStore } from '../src/stores/assistant-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const WAIT = { timeout: 20_000 };
const OLD_URL = 'https://old.example.com/hook';
const NEW_URL = 'https://new.example.com/hook';

const trigger: WorkflowNode = {
  id: 'n-start',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const httpNode = (url: string): WorkflowNode => ({
  id: 'n-post',
  name: 'Post',
  type: 'core.httpRequest',
  typeVersion: 1,
  position: [240, 0],
  parameters: { method: 'POST', url },
});
const CONNECTIONS = { Start: { main: [[{ node: 'Post', type: 'main' as const, index: 0 }]] } };

function draftDto(overrides: Partial<AssistantDraftDTO> = {}): AssistantDraftDTO {
  return {
    id: 'draft-1',
    name: 'Hook poster',
    workflowId: null,
    baseVersionId: null,
    status: 'open',
    definition: { name: 'Hook poster', nodes: [trigger, httpNode(NEW_URL)], connections: CONNECTIONS },
    nodeCount: 2,
    issues: [],
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

/** a saved workflow, a thread that is open in the store, and a draft that changes the workflow's URL */
async function draftOfSavedWorkflow() {
  const saved = await workflowsApi.create({
    name: 'Hook poster',
    nodes: [trigger, httpNode(OLD_URL)],
    connections: CONNECTIONS,
  } as Parameters<typeof workflowsApi.create>[0]);
  const thread = await assistantApi.createThread({});
  useAssistantStore.setState({ activeThreadId: thread.id });
  const draft = addDemoDraft(
    backend(),
    thread.id,
    draftDto({ workflowId: saved.id, baseVersionId: saved.versionId }),
  );
  return { saved, threadId: thread.id, draft };
}

function renderCard(draft: AssistantDraftDTO) {
  return withProviders(
    <MemoryRouter>
      <DraftCard draft={{ type: 'draft', draftId: draft.id, name: draft.name }} />
    </MemoryRouter>,
  );
}

/** the card once its draft has loaded (the node count shows) */
async function loadedCard(name: string): Promise<HTMLElement> {
  const card = await screen.findByRole('region', { name }, WAIT);
  await within(card).findByText(/\d+ nodes?/, undefined, WAIT);
  return card;
}

const draftPosts = (kind: 'accept' | 'discard') =>
  backend().requests.filter(
    (r: ApiRequest) => r.method === 'POST' && r.path.endsWith(`/drafts/draft-1/${kind}`),
  );

beforeEach(() => {
  signedIn();
  assistantDemoState(backend()).stepMs = 0;
  setAssistantStreamConnector(demoAssistantStream(backend()));
});

afterEach(() => {
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
});

describe('DraftCard', () => {
  it('shows the name, the node count and the URL change', async () => {
    const { saved } = await draftOfSavedWorkflow();
    renderCard(draftDto());
    const card = await loadedCard('Draft Hook poster');
    expect(within(card).getByText('Hook poster')).toBeTruthy();
    expect(within(card).getByText(/2 nodes/)).toBeTruthy();
    const diff = within(card).getByRole('group', { name: 'Changes to Post' });
    expect(within(diff).getByText('url')).toBeTruthy();
    expect(within(diff).getByText(OLD_URL)).toBeTruthy();
    expect(within(diff).getByText(NEW_URL)).toBeTruthy();
    // nothing is saved by showing it
    const stored = backend().workflows.find((w) => w.id === saved.id);
    expect(JSON.stringify(stored?.nodes)).toContain(OLD_URL);
    expect(useAssistantStore.getState().drafts['draft-1']?.draft.id).toBe('draft-1');
  });

  it('Accept saves the workflow once and offers Open', async () => {
    const { saved } = await draftOfSavedWorkflow();
    renderCard(draftDto());
    const card = await loadedCard('Draft Hook poster');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    const open = await within(card).findByRole('link', { name: 'Open workflow' }, WAIT);
    expect(open.getAttribute('href')).toBe(`/workflow/${saved.id}`);
    expect(within(card).getByText('Saved')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(draftPosts('accept')).toHaveLength(1);
    const stored = backend().workflows.find((w) => w.id === saved.id);
    expect(JSON.stringify(stored?.nodes)).toContain(NEW_URL);
    expect(stored?.versionId).not.toBe(saved.versionId);
  });

  it('Discard saves nothing', async () => {
    const { saved } = await draftOfSavedWorkflow();
    const count = backend().workflows.length;
    renderCard(draftDto());
    const card = await loadedCard('Draft Hook poster');
    fireEvent.click(within(card).getByRole('button', { name: 'Discard' }));
    await within(card).findByText('Discarded. Nothing was saved.', undefined, WAIT);
    expect(draftPosts('discard')).toHaveLength(1);
    expect(draftPosts('accept')).toHaveLength(0);
    expect(backend().workflows).toHaveLength(count);
    const stored = backend().workflows.find((w) => w.id === saved.id);
    expect(stored?.versionId).toBe(saved.versionId);
    expect(JSON.stringify(stored?.nodes)).toContain(OLD_URL);
  });

  it('a changed workflow stays in the card with the reason and a link', async () => {
    const { saved } = await draftOfSavedWorkflow();
    // someone saves the workflow after the draft was built
    await workflowsApi.update(saved.id, { versionId: saved.versionId, name: 'Hook poster' } as Parameters<
      typeof workflowsApi.update
    >[1]);
    renderCard(draftDto());
    const card = await loadedCard('Draft Hook poster');
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await within(card).findByText("Couldn't save the draft", undefined, WAIT);
    expect(within(card).getByText(/The workflow changed. Build again or open it/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the workflow' }).getAttribute('href')).toBe(
      `/workflow/${saved.id}`,
    );
    expect(within(card).getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('a project viewer keeps Accept and Discard: it creates in its personal project (P6-39)', async () => {
    await draftOfSavedWorkflow();
    backend().setDemoRole('viewer');
    renderCard(draftDto());
    const card = await loadedCard('Draft Hook poster');
    await waitFor(
      () =>
        expect((within(card).getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false),
      WAIT,
    );
    expect((within(card).getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(card).queryByText(DRAFT_VIEWER_REASON)).toBeNull();
  });

  it('a new workflow lists the nodes it adds, and markup stays text', async () => {
    const thread = await assistantApi.createThread({});
    useAssistantStore.setState({ activeThreadId: thread.id });
    const name = '<img src=x onerror=alert(1)> poster';
    const draft = addDemoDraft(
      backend(),
      thread.id,
      draftDto({
        name,
        definition: {
          name,
          nodes: [trigger, { ...httpNode(NEW_URL), name: '<b>Post</b>' }],
          connections: {},
        },
      }),
    );
    const count = backend().workflows.length;
    const { container } = renderCard(draft);
    const card = await loadedCard(`Draft ${name}`);
    expect(within(card).getByText('Adds <b>Post</b>')).toBeTruthy();
    expect(within(card).getByText(name)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await within(card).findByRole('link', { name: 'Open workflow' }, WAIT);
    expect(backend().workflows).toHaveLength(count + 1);
  });

  it('the thread shows the card for a draft artifact', async () => {
    const thread = await assistantApi.createThread({});
    renderApp(`/assistant/${thread.id}`);
    const composer = await screen.findByRole('textbox', { name: 'Message' }, WAIT);
    await waitFor(() => expect(useAssistantStore.getState().activeThreadId).toBe(thread.id), WAIT);
    // a draft comes with a turn: the thread holds messages
    const user = userEvent.setup();
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false), WAIT);
    await user.click(composer);
    await user.type(composer, 'Hello');
    await user.keyboard('{Enter}');
    await screen.findByText(/This is the demo Assistant/, undefined, WAIT);
    // the stream is open: the draft's artifact arrives live
    await waitFor(
      () => expect(assistantDemoState(backend()).listeners.get(thread.id)?.size ?? 0).toBeGreaterThan(0),
      WAIT,
    );
    addDemoDraft(backend(), thread.id, draftDto());
    await screen.findByRole('region', { name: 'Draft Hook poster' }, WAIT);
    expect(await screen.findByText(/2 nodes/, undefined, WAIT)).toBeTruthy();
  });
});
