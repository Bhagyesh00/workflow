/**
 * P5-67 (L2): artifacts. An `artifact` event lists the workflow or data table in the panel; Open on a workflow
 * shows it as a read-only canvas with Open to the editor; Open on a data table shows its first 20 rows through
 * the data table API; the panel lists each artifact once and a draft opens its card in the thread.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { dataTablesApi } from '../src/api/endpoints';
import { ArtifactsPanel } from '../src/components/assistant/ArtifactsPanel';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const WAIT = { timeout: 20_000 };

const node = (id: string, name: string, type: string, x: number) =>
  ({ id, name, type, typeVersion: 1, position: [x, 0], parameters: {} }) as WorkflowNode;

beforeEach(() => {
  signedIn();
  useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  assistantDemoState(backend()).stepMs = 0;
  setAssistantStreamConnector(demoAssistantStream(backend()));
});

afterEach(() => {
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
});

async function ask(text: string) {
  const utils = renderApp('/assistant');
  const composer = await screen.findByRole('textbox', { name: 'Message' }, WAIT);
  const user = userEvent.setup();
  await user.click(composer);
  await user.type(composer, `${text}{Enter}`);
  const panel = await screen.findByRole('region', { name: 'Artifacts' }, WAIT);
  return { ...utils, user, panel };
}

describe('Assistant artifacts (P5-67)', () => {
  it('opens a workflow artifact as a read-only preview with Open', async () => {
    const wf = backend().seedWorkflow({
      name: 'Order intake',
      nodes: [node('t', 'New order', 'core.manualTrigger', 0), node('s', 'Shape order', 'core.set', 300)],
      connections: { 'New order': { main: [[{ node: 'Shape order', type: 'main', index: 0 }]] } },
    });
    const { user, panel } = await ask('List my workflows');
    const open = await within(panel).findByRole('button', { name: 'Open Order intake' }, WAIT);
    expect(within(panel).getByText('Workflow')).toBeTruthy();
    const writesBefore = backend().requests.filter((r: ApiRequest) => r.method !== 'GET').length;
    await user.click(open);
    const dialog = await screen.findByRole('dialog', undefined, WAIT);
    const preview = await within(dialog).findByRole('region', { name: 'Preview of Order intake' }, WAIT);
    expect(within(preview).getByText(/2 nodes · Read only/)).toBeTruthy();
    expect(await within(preview).findByText('Shape order', undefined, WAIT)).toBeTruthy();
    expect(within(preview).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      `/workflow/${wf.id}`,
    );
    // the read-only canvas offers no node actions and the preview writes nothing
    expect(within(preview).queryByRole('button', { name: /Delete|Add node/ })).toBeNull();
    expect(backend().requests.filter((r: ApiRequest) => r.method !== 'GET')).toHaveLength(writesBefore);
    expect(
      backend().requests.some((r: ApiRequest) => r.method === 'GET' && r.path === `/workflows/${wf.id}`),
    ).toBe(true);
  });

  it('shows the first 20 rows of a data table artifact through the data table API', async () => {
    const table = await dataTablesApi.create({
      name: 'Leads',
      columns: [
        { name: 'email', type: 'string' },
        { name: 'score', type: 'number' },
      ],
    });
    await dataTablesApi.insertRows(
      table.id,
      Array.from({ length: 25 }, (_, i) => ({ email: `lead${i + 1}@example.com`, score: i + 1 })),
      'count',
    );
    const { user, panel } = await ask('Which data tables do I have?');
    await user.click(await within(panel).findByRole('button', { name: 'Open Leads' }, WAIT));
    const preview = await screen.findByRole('region', { name: 'Preview of Leads' }, WAIT);
    expect(within(preview).getByText('Showing 20 of 25 rows')).toBeTruthy();
    const rows = within(preview).getAllByRole('row');
    // the header and 20 rows
    expect(rows).toHaveLength(21);
    expect(
      within(rows[0])
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['id', 'email', 'score']);
    expect(within(rows[1]).getByText('lead1@example.com')).toBeTruthy();
    expect(within(preview).queryByText('lead21@example.com')).toBeNull();
    expect(within(preview).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      `/data-tables/${table.id}`,
    );
    const read = backend().requests.find(
      (r: ApiRequest) => r.method === 'GET' && r.path === `/data-tables/${table.id}/rows`,
    );
    expect(String(read?.query?.take)).toBe('20');
  });

  it('lists each artifact once and says when there is none', async () => {
    const { rerender } = withProviders(<ArtifactsPanel artifacts={[]} />);
    expect(screen.getByText(/Workflows and tables the Assistant makes or finds show here/)).toBeTruthy();
    rerender(
      <ArtifactsPanel
        artifacts={[
          { type: 'workflow', id: 'w1', name: 'Orders' },
          { type: 'data-table', id: 't1', name: 'Leads' },
          { type: 'draft', draftId: 'd1', name: 'Lead router' },
        ]}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Artifacts' });
    expect(
      within(panel)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['OrdersWorkflowOpen', 'LeadsData tableOpen', 'Lead routerDraftOpen']);
  });

  it('opens a draft artifact at its card in the thread', async () => {
    const card = document.createElement('div');
    card.id = 'assistant-draft-d1';
    card.tabIndex = -1;
    let scrolled = false;
    card.scrollIntoView = () => {
      scrolled = true;
    };
    document.body.appendChild(card);
    try {
      withProviders(<ArtifactsPanel artifacts={[{ type: 'draft', draftId: 'd1', name: 'Lead router' }]} />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Open Lead router' }));
      await waitFor(() => expect(scrolled).toBe(true));
      expect(document.activeElement).toBe(card);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      card.remove();
    }
  });
});
