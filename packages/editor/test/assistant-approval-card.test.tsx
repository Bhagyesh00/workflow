/**
 * P5-68 (L3): the approval card. It renders the title with the resource name, the facts, the preview with what
 * was left out, the Assistant's own words apart, the session button only when offered and the countdown only
 * with a timeout; Approve, Always allow this session and Deny send the right answer (never args); markup in a
 * value stays text; a card that is no longer open says so and leaves the list; on the page, the card waits,
 * Approve resolves it through the stream and the turn answers.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AssistantConfirmation } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { assistantApi } from '../src/api/endpoints';
import type { AssistantConfirmationOf } from '../src/api/types';
import { ApprovalCard, approvalTimeLeft } from '../src/components/assistant/ApprovalCard';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { addDemoConfirmation } from '../src/demo/mock-assistant-confirm';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

const WAIT = { timeout: 20_000 };

function card(
  overrides: Partial<AssistantConfirmationOf<'approval'>> = {},
): AssistantConfirmationOf<'approval'> {
  return {
    requestId: 'req-1',
    toolCallId: 'call-1',
    toolName: 'add_rows',
    title: 'Add rows',
    resourceName: 'Leads',
    approvalSummary: 'Adds the three new leads from the form',
    allowSession: true,
    expiresAt: new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000).toISOString(),
    createdAt: '2026-11-08T00:00:00.000Z',
    inputType: 'approval',
    details: {
      facts: [
        { label: 'Table', value: 'Leads' },
        { label: 'Rows', value: '5' },
      ],
      preview: {
        columns: ['name', 'email'],
        rows: [
          ['Ada', 'ada@example.com'],
          ['Bob', 'bob@example.com'],
          ['Cy', 'cy@example.com'],
        ],
        omittedRows: 2,
        omittedColumns: 1,
      },
    },
    ...overrides,
  };
}

const confirms = () =>
  backend().requests.filter((r: ApiRequest) => r.method === 'POST' && /^\/assistant\/confirm\//.test(r.path));

/** a demo thread of the signed-in user with `confirmation` waiting on it */
async function threadWithCard(confirmation: AssistantConfirmation) {
  const created = await assistantApi.createThread({});
  addDemoConfirmation(backend(), created.id, confirmation);
  return created.id;
}

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

describe('ApprovalCard (P5-68)', () => {
  it('renders the title, resource, facts, preview with omitted counts, summary apart and countdown', () => {
    withProviders(<ApprovalCard confirmation={card()} />);
    const group = screen.getByRole('group', { name: 'Approve Add rows: Leads' });
    expect(within(group).getByText('Leads', { selector: 'strong' })).toBeTruthy();
    expect(within(group).getByText('Table')).toBeTruthy();
    expect(within(group).getByText('Rows')).toBeTruthy();
    expect(within(group).getByText('5')).toBeTruthy();
    const table = within(group).getByRole('table', { name: 'Preview' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['name', 'email']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('cy@example.com')).toBeTruthy();
    expect(within(group).getByText('2 more rows, 1 more column not shown')).toBeTruthy();
    expect(within(group).getByText('The Assistant says')).toBeTruthy();
    expect(within(group).getByText('Adds the three new leads from the form')).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Always allow this session' })).toBeTruthy();
    expect(within(group).getByText('Expires in 2 h 5 min')).toBeTruthy();
  });

  it('offers no session button without allowSession and no countdown without a timeout', () => {
    withProviders(
      <ApprovalCard
        confirmation={card({
          allowSession: false,
          expiresAt: null,
          resourceName: undefined,
          approvalSummary: undefined,
        })}
      />,
    );
    const group = screen.getByRole('group', { name: 'Approve Add rows' });
    expect(within(group).queryByRole('button', { name: 'Always allow this session' })).toBeNull();
    expect(within(group).queryByText(/Expires in/)).toBeNull();
    expect(within(group).queryByText('The Assistant says')).toBeNull();
  });

  it('shows a timed-out card with its buttons off', () => {
    withProviders(
      <ApprovalCard confirmation={card({ expiresAt: new Date(Date.now() - 1000).toISOString() })} />,
    );
    expect(screen.getByText('This request timed out')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps markup in a value as text', () => {
    const markup = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    withProviders(
      <ApprovalCard
        confirmation={card({
          title: '<script>alert(1)</script>',
          resourceName: markup,
          approvalSummary: markup,
          details: {
            facts: [{ label: '<i>label</i>', value: markup }],
            preview: { columns: ['<u>c</u>'], rows: [[markup]], omittedRows: 0, omittedColumns: 0 },
          },
        })}
      />,
    );
    expect(document.querySelector('img, script, b, i, u')).toBeNull();
    expect(screen.getAllByText(markup).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('<i>label</i>')).toBeTruthy();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it.each([
    ['Approve', { kind: 'approval', approved: true, scope: 'once' }],
    ['Always allow this session', { kind: 'approval', approved: true, scope: 'session' }],
    ['Deny', { kind: 'approval', approved: false }],
  ] as const)('%s sends the right answer and no args', async (button, answer) => {
    const confirmation = card({ requestId: `req-${button.length}` });
    await threadWithCard(confirmation);
    withProviders(<ApprovalCard confirmation={confirmation} />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].path).toBe(`/assistant/confirm/${confirmation.requestId}`);
    expect(confirms()[0].body).toEqual(answer);
    // sent once: the buttons stay off until the card leaves
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('says so when the card is no longer open, and drops it from the list', async () => {
    const confirmation = card({ requestId: 'req-gone' });
    useAssistantStore.setState({ pending: [confirmation] });
    withProviders(<ApprovalCard confirmation={confirmation} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => [t.title, t.description])).toContainEqual([
        "Couldn't send your answer",
        'This request is no longer open.',
      ]),
    );
    expect(useAssistantStore.getState().pending).toEqual([]);
  });

  it('counts down in hours, minutes and seconds', () => {
    const at = Date.parse('2026-11-08T00:00:00.000Z');
    const iso = (ms: number) => new Date(at + ms).toISOString();
    expect(approvalTimeLeft(iso(24 * 3_600_000), at)).toBe('24 h');
    expect(approvalTimeLeft(iso(3_600_000 + 60_000), at)).toBe('1 h 1 min');
    expect(approvalTimeLeft(iso(90_000), at)).toBe('2 min');
    expect(approvalTimeLeft(iso(12_000), at)).toBe('12 s');
    expect(approvalTimeLeft(iso(0), at)).toBeNull();
  });

  it('on the page: the card waits, Approve resolves it and the turn answers', async () => {
    const confirmation = card({ requestId: 'req-page' });
    const threadId = await threadWithCard(confirmation);
    renderApp(`/assistant/${threadId}`);
    const group = await screen.findByRole('group', { name: 'Approve Add rows: Leads' }, WAIT);
    expect(group.closest('[data-request-id="req-page"]')).not.toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText('Done. It ran with the values you approved.', undefined, WAIT),
    ).toBeTruthy();
    await waitFor(
      () => expect(screen.queryByRole('group', { name: 'Approve Add rows: Leads' })).toBeNull(),
      WAIT,
    );
    expect(confirms().map((r) => r.body)).toEqual([{ kind: 'approval', approved: true, scope: 'once' }]);
    // a second answer to the same card is 404 on the demo, as on the server
    await expect(
      assistantApi.confirm('req-page', { kind: 'approval', approved: true }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
