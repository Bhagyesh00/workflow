/**
 * P5-64: the web fetch approval in the AI builder panel. The builder asks to read a page: the panel shows
 * the website and the URL as text with Approve and Deny, nothing is sent until one is pressed, and the
 * answer goes out as `resumeData.webFetch` on a new turn with no text.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuilderChunk, BuildRequest } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BuildStreamConnector, setBuildStreamConnector } from '../src/api/ai-stream';
import { WebFetchApprovalMessage } from '../src/components/assistant/WebFetchApprovalMessage';
import { decideWebFetch } from '../src/features/builder/web-fetch-actions';
import { useBuilderStore } from '../src/stores/builder-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const URL_ASKED = 'https://docs.example.com/api/start';

/** turn 1 asks to read the page; every later turn is plain text */
function connector(first: BuilderChunk[], gate?: Promise<void>) {
  const bodies: BuildRequest[] = [];
  const play: BuildStreamConnector = async (body, onChunk) => {
    bodies.push(body);
    const chunks: BuilderChunk[] =
      bodies.length === 1
        ? first
        : [{ type: 'message', id: `r${bodies.length}`, text: 'Carrying on.', delta: true }];
    for (const chunk of chunks) onChunk(chunk);
    if (gate && bodies.length > 1) await gate;
  };
  setBuildStreamConnector(play);
  return bodies;
}

const ASK: BuilderChunk[] = [
  { type: 'message', id: 'a1', text: 'I want to read the docs.', delta: true },
  { type: 'web-fetch-approval', url: URL_ASKED, domain: 'docs.example.com' },
];

async function openPanel(chunks: BuilderChunk[], gate?: Promise<void>) {
  const wf = backend().seedWorkflow({ name: 'Docs', nodes: [], connections: {} });
  const bodies = connector(chunks, gate);
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  const user = userEvent.setup();
  const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' });
  await user.click(entry);
  const panel = await screen.findByRole('complementary', { name: 'AI builder' });
  await user.type(within(panel).getByRole('textbox', { name: 'Message the AI builder' }), 'Use the docs');
  await user.click(within(panel).getByRole('button', { name: 'Send' }));
  return { user, panel, bodies, workflowId: wf.id };
}

describe('web fetch approval (P5-64)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
  });
  afterEach(() => {
    setBuildStreamConnector(null);
    useBuilderStore.getState().reset();
  });

  it('shows the website and the URL, and sends nothing until a button is pressed', async () => {
    const { panel, bodies } = await openPanel(ASK);
    const card = await within(panel).findByRole('group', { name: 'Web page approval' });
    expect(within(card).getByText('docs.example.com')).toBeTruthy();
    expect(within(card).getByText(URL_ASKED)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(useBuilderStore.getState().pendingWebFetch).toEqual({
      url: URL_ASKED,
      domain: 'docs.example.com',
    });
    expect(bodies).toHaveLength(1);
  });

  it('Approve sends the answer as resumeData with no text, and the card goes away', async () => {
    const { user, panel, bodies, workflowId } = await openPanel(ASK);
    const card = await within(panel).findByRole('group', { name: 'Web page approval' });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({
      workflowId,
      text: '',
      resumeData: { webFetch: { url: URL_ASKED, decision: 'approve' } },
    });
    await waitFor(() => expect(within(panel).queryByRole('group', { name: 'Web page approval' })).toBeNull());
    expect(await within(panel).findByText('Carrying on.')).toBeTruthy();
    expect(useBuilderStore.getState().pendingWebFetch).toBeNull();
    // the empty text is not shown as a message of the user
    expect(
      useBuilderStore
        .getState()
        .messages.filter((m) => m.role === 'user')
        .map((m) => m.text),
    ).toEqual(['Use the docs']);
  });

  it('Deny sends the refusal', async () => {
    const { user, panel, bodies } = await openPanel(ASK);
    const card = await within(panel).findByRole('group', { name: 'Web page approval' });
    await user.click(within(card).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].resumeData).toEqual({ webFetch: { url: URL_ASKED, decision: 'deny' } });
    await waitFor(() => expect(within(panel).queryByRole('group', { name: 'Web page approval' })).toBeNull());
  });

  it('shows the website and URL as text, never as markup', async () => {
    const evil = 'https://x.example.com/<img src=x onerror=alert(1)>';
    const { panel } = await openPanel([
      { type: 'web-fetch-approval', url: evil, domain: '<b>bold</b>.example.com' },
    ]);
    const card = await within(panel).findByRole('group', { name: 'Web page approval' });
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    expect(within(card).getByText(evil)).toBeTruthy();
    expect(within(card).getByText('<b>bold</b>.example.com')).toBeTruthy();
  });

  it('keeps both buttons off while a turn streams', async () => {
    useBuilderStore.setState({ streaming: true });
    const { render } = await import('@testing-library/react');
    render(<WebFetchApprovalMessage url={URL_ASKED} domain="docs.example.com" />);
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('decideWebFetch does nothing without a panel (no deps) and never throws', async () => {
    await expect(decideWebFetch(URL_ASKED, 'approve')).resolves.toBeUndefined();
  });
});
