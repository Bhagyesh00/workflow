/**
 * P5-70 (L7), fix round S5: the draft card shows one version and Accept saves exactly that one. Accept sends the
 * version shown (`draft.updatedAt`); a new `artifact` event for the same draft (the Assistant rebuilt it) loads the
 * new version and Accept waits for it; a refused Accept (409) loads the draft again. Each added node shows its type
 * and its parameters, not only the name the model gave it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssistantDraftDTO, WorkflowNode } from '@workflow/workflow';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import { ApiError, type ApiRequest } from '../src/api/client';
import { assistantApi } from '../src/api/endpoints';
import { DraftCard } from '../src/components/assistant/DraftCard';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { addDemoDraft } from '../src/demo/mock-assistant-drafts';
import { useAssistantStore } from '../src/stores/assistant-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const WAIT = { timeout: 20_000 };
const URL_SHOWN = 'https://hooks.example.com/shown';

const trigger: WorkflowNode = {
  id: 'n-start',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const post: WorkflowNode = {
  id: 'n-post',
  name: 'Format data',
  type: 'core.httpRequest',
  typeVersion: 1,
  position: [240, 0],
  parameters: { method: 'POST', url: URL_SHOWN },
};
const finish: WorkflowNode = {
  id: 'n-finish',
  name: 'Finish',
  type: 'core.set',
  typeVersion: 1,
  position: [480, 0],
  parameters: { mode: 'manual' },
};

function draftDto(nodes: WorkflowNode[], updatedAt: string): AssistantDraftDTO {
  return {
    id: 'draft-v',
    name: 'Poster',
    workflowId: null,
    baseVersionId: null,
    status: 'open',
    definition: { name: 'Poster', nodes, connections: {} },
    nodeCount: nodes.length,
    issues: [],
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt,
  };
}

const V1 = '2026-11-08T00:00:01.000Z';
const V2 = '2026-11-08T00:00:02.000Z';

/** the card as the thread view shows it: fed by the store's artifact for this draft */
function ThreadDraft() {
  const artifact = useAssistantStore((s) =>
    s.artifacts.find((a) => a.type === 'draft' && a.draftId === 'draft-v'),
  );
  return artifact?.type === 'draft' ? <DraftCard draft={artifact} /> : null;
}

/** the artifact event `build_workflow` sends for the draft (first build or a rebuild) */
function artifactEvent() {
  useAssistantStore.getState().applyEvent({
    type: 'artifact',
    runId: null,
    payload: { artifact: { type: 'draft', draftId: 'draft-v', name: 'Poster' } },
  });
}

async function openThreadWith(nodes: WorkflowNode[], updatedAt: string): Promise<string> {
  const thread = await assistantApi.createThread({});
  useAssistantStore.setState({ activeThreadId: thread.id });
  addDemoDraft(backend(), thread.id, draftDto(nodes, updatedAt));
  return thread.id;
}

const acceptBodies = () =>
  backend()
    .requests.filter((r: ApiRequest) => r.method === 'POST' && r.path.endsWith('/drafts/draft-v/accept'))
    .map((r: ApiRequest) => r.body);

async function loadedCard(text: string): Promise<HTMLElement> {
  const card = await screen.findByRole('region', { name: 'Draft Poster' }, WAIT);
  await within(card).findByText(text, undefined, WAIT);
  return card;
}

beforeEach(() => {
  signedIn();
  assistantDemoState(backend()).stepMs = 0;
  setAssistantStreamConnector(demoAssistantStream(backend()));
});

afterEach(() => {
  vi.restoreAllMocks();
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
});

describe('DraftCard versions', () => {
  it('Accept sends the version the card shows', async () => {
    await openThreadWith([trigger, post], V1);
    artifactEvent();
    withProviders(
      <MemoryRouter>
        <ThreadDraft />
      </MemoryRouter>,
    );
    const card = await loadedCard('Adds Format data');
    await userEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await within(card).findByRole('link', { name: 'Open workflow' }, WAIT);
    expect(acceptBodies()).toEqual([{ updatedAt: V1 }]);
  });

  it('a rebuild (a new artifact event) loads the new version before Accept', async () => {
    const threadId = await openThreadWith([trigger, post], V1);
    artifactEvent();
    withProviders(
      <MemoryRouter>
        <ThreadDraft />
      </MemoryRouter>,
    );
    const card = await loadedCard('Adds Format data');
    expect(within(card).queryByText('Adds Finish')).toBeNull();

    // the Assistant rebuilds the same draft
    addDemoDraft(backend(), threadId, draftDto([trigger, post, finish], V2));
    artifactEvent();
    await within(card).findByText('Adds Finish', undefined, WAIT);
    expect(within(card).getByText(/3 nodes/)).toBeTruthy();
    const accept = within(card).getByRole('button', { name: 'Accept' });
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false), WAIT);
    await userEvent.click(accept);
    await within(card).findByRole('link', { name: 'Open workflow' }, WAIT);
    expect(acceptBodies()).toEqual([{ updatedAt: V2 }]);
  });

  it('a refused Accept (409) loads the draft again and keeps the reason', async () => {
    const threadId = await openThreadWith([trigger, post], V1);
    artifactEvent();
    withProviders(
      <MemoryRouter>
        <ThreadDraft />
      </MemoryRouter>,
    );
    const card = await loadedCard('Adds Format data');
    // the stored draft changed and the server refuses the version the card shows
    addDemoDraft(backend(), threadId, draftDto([trigger, post, finish], V2));
    const refused = vi
      .spyOn(assistantApi, 'acceptDraft')
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'The draft changed. Review it again'));
    await userEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    expect(
      await within(card).findByText(/The draft changed\. Review it again/, undefined, WAIT),
    ).toBeTruthy();
    await within(card).findByText('Adds Finish', undefined, WAIT);
    expect(refused).toHaveBeenCalledWith(threadId, 'draft-v', { updatedAt: V1 });
  });

  it('each added node shows its type and its parameters', async () => {
    await openThreadWith([trigger, post], V1);
    artifactEvent();
    withProviders(
      <MemoryRouter>
        <ThreadDraft />
      </MemoryRouter>,
    );
    const card = await loadedCard('Adds Format data');
    const line = within(card).getByText('Adds Format data').closest('li') as HTMLElement;
    // the type's display name once the node types load (its id until then)
    await waitFor(() => expect(line.textContent).toContain('HTTP Request'), WAIT);
    const diff = within(card).getByRole('group', { name: 'Changes to Format data' });
    expect(within(diff).getByText('url')).toBeTruthy();
    expect(within(diff).getByText(URL_SHOWN)).toBeTruthy();
    expect(within(diff).getByText('method')).toBeTruthy();
  });
});
