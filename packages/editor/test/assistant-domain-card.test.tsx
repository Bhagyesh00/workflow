/**
 * P5-73 (L10): the domain card of `fetch_url`. It shows the full URL and the host as text (markup stays text),
 * sends each of the four actions as a `domain` answer and no args, turns its buttons off after one answer, says
 * so when the card is no longer open, and shows a timed-out card with its buttons off.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { assistantApi } from '../src/api/endpoints';
import type { AssistantConfirmationOf } from '../src/api/types';
import { DomainApprovalCard } from '../src/components/assistant/DomainApprovalCard';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { addDemoConfirmation } from '../src/demo/mock-assistant-confirm';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const WAIT = { timeout: 20_000 };

function card(overrides: Partial<AssistantConfirmationOf<'domain'>> = {}): AssistantConfirmationOf<'domain'> {
  return {
    requestId: 'dom-1',
    toolCallId: 'call-1',
    toolName: 'fetch_url',
    title: 'Read a web page',
    allowSession: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: '2026-11-08T00:00:00.000Z',
    inputType: 'domain',
    details: { url: 'https://docs.example.com/guide/start?x=1', host: 'docs.example.com' },
    ...overrides,
  };
}

const confirms = () =>
  backend().requests.filter((r: ApiRequest) => r.method === 'POST' && /^\/assistant\/confirm\//.test(r.path));

beforeEach(() => {
  signedIn();
  useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  useToastStore.setState({ toasts: [] });
  assistantDemoState(backend()).stepMs = 0;
  setAssistantStreamConnector(demoAssistantStream(backend()));
});

afterEach(() => {
  useAssistantStore.getState().reset();
  setAssistantStreamConnector(null);
});

describe('DomainApprovalCard (P5-73)', () => {
  it('shows the full URL and the host as text, with the three choices and Deny', () => {
    withProviders(<DomainApprovalCard confirmation={card()} />);
    const group = screen.getByRole('group', { name: 'Allow reading docs.example.com' });
    expect(within(group).getByText('docs.example.com')).toBeTruthy();
    expect(within(group).getByText('https://docs.example.com/guide/start?x=1')).toBeTruthy();
    expect(within(group).queryByRole('link')).toBeNull();
    for (const name of ['Allow once', 'Allow this website', 'Allow all websites', 'Deny']) {
      expect(within(group).getByRole('button', { name })).toBeTruthy();
    }
    expect(within(group).getByText(/Expires in/)).toBeTruthy();
  });

  it('keeps markup in the URL and the host as text', () => {
    const markup = '<img src=x onerror="window.__pwned=1">';
    withProviders(
      <DomainApprovalCard
        confirmation={card({ title: '<b>t</b>', details: { url: `https://a.test/${markup}`, host: markup } })}
      />,
    );
    expect(document.querySelector('img, b')).toBeNull();
    expect(screen.getByText(markup)).toBeTruthy();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('shows no countdown without a timeout and a timed-out card with its buttons off', () => {
    const { unmount } = withProviders(<DomainApprovalCard confirmation={card({ expiresAt: null })} />);
    expect(screen.queryByText(/Expires in/)).toBeNull();
    unmount();
    withProviders(
      <DomainApprovalCard confirmation={card({ expiresAt: new Date(Date.now() - 1000).toISOString() })} />,
    );
    expect(screen.getByText('This request timed out')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['Allow once', 'allow_once'],
    ['Allow this website', 'allow_domain'],
    ['Allow all websites', 'allow_all'],
    ['Deny', 'deny'],
  ] as const)('%s sends the %s answer and no args', async (button, action) => {
    const confirmation = card({ requestId: `dom-${action}` });
    const created = await assistantApi.createThread({});
    addDemoConfirmation(backend(), created.id, confirmation);
    withProviders(<DomainApprovalCard confirmation={confirmation} />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].path).toBe(`/assistant/confirm/${confirmation.requestId}`);
    expect(confirms()[0].body).toEqual({ kind: 'domain', action });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('says so when the card is no longer open, and drops it from the list', async () => {
    const confirmation = card({ requestId: 'dom-gone' });
    useAssistantStore.setState({ pending: [confirmation] });
    withProviders(<DomainApprovalCard confirmation={confirmation} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => [t.title, t.description])).toContainEqual([
        "Couldn't send your answer",
        'This request is no longer open.',
      ]),
    );
    expect(useAssistantStore.getState().pending).toEqual([]);
  });
});
