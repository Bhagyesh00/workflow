/**
 * P5-69 (L6): the Assistant's questions card, task checklist and credential setup card. Questions of each type
 * (single, multi, text), skip per question and dismiss send the right answer once; markup in the Assistant's words
 * stays text; a closed card says so. The checklist shows each state as text and icon. The credential card picks an
 * existing credential, creates one in the credential dialog, or skips, and sends only the id.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AssistantConfirmation, AssistantTask } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAssistantStreamConnector } from '../src/api/assistant-stream';
import type { ApiRequest } from '../src/api/client';
import { assistantApi, credentialsApi } from '../src/api/endpoints';
import type { AssistantConfirmationOf } from '../src/api/types';
import { CredentialSetupCard } from '../src/components/assistant/CredentialSetupCard';
import { QuestionsCard } from '../src/components/assistant/QuestionsCard';
import { TaskChecklist } from '../src/components/assistant/TaskChecklist';
import { assistantDemoState, demoAssistantStream } from '../src/demo/mock-assistant';
import { addDemoConfirmation } from '../src/demo/mock-assistant-confirm';
import { useAssistantStore } from '../src/stores/assistant-store';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const WAIT = { timeout: 20_000 };
const MARKUP = '<img src=x onerror="alert(1)"><b>bold</b>';

const base = {
  toolCallId: 'call-1',
  allowSession: false,
  expiresAt: null,
  createdAt: '2026-11-08T00:00:00.000Z',
};

function questionsCard(
  overrides: Partial<AssistantConfirmationOf<'questions'>> = {},
): AssistantConfirmationOf<'questions'> {
  return {
    ...base,
    requestId: `req-q-${Math.random().toString(36).slice(2)}`,
    toolName: 'ask_user',
    title: 'A few questions for you',
    inputType: 'questions',
    details: {
      introMessage: 'Before I build it',
      questions: [
        { id: 'q1', question: 'Which channel?', type: 'single', options: ['#sales', '#ops'] },
        { id: 'q2', question: 'Which days?', type: 'multi', options: ['Mon', 'Tue', 'Wed'] },
        { id: 'q3', question: 'Any note?', type: 'text' },
      ],
    },
    ...overrides,
  };
}

function credentialCard(
  overrides: Partial<AssistantConfirmationOf<'credential'>> = {},
): AssistantConfirmationOf<'credential'> {
  return {
    ...base,
    requestId: `req-c-${Math.random().toString(36).slice(2)}`,
    toolName: 'setup_credentials',
    title: 'Set up a credential',
    resourceName: 'Basic Auth',
    inputType: 'credential',
    details: {
      credentialType: 'httpBasicAuth',
      displayName: 'Basic Auth',
      reason: 'The request needs a login',
    },
    ...overrides,
  };
}

const confirms = () =>
  backend().requests.filter((r: ApiRequest) => r.method === 'POST' && /^\/assistant\/confirm\//.test(r.path));

/** a demo thread of the signed-in user with `confirmation` waiting on it */
async function open(confirmation: AssistantConfirmation) {
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

describe('QuestionsCard', () => {
  it('asks each question by its type and sends the answers, a skipped one with none', async () => {
    const card = questionsCard();
    await open(card);
    withProviders(<QuestionsCard confirmation={card} />);
    const form = screen.getByRole('form', { name: 'Questions: A few questions for you' });
    expect(within(form).getByText('Before I build it')).toBeTruthy();
    const send = within(form).getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    expect(within(form).getAllByRole('radio')).toHaveLength(2);
    expect(within(form).getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.click(within(form).getByRole('radio', { name: '#ops' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Mon' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Wed' }));
    expect(send.disabled).toBe(true);

    // skip the text question
    const third = form.querySelector('[data-question-id="q3"]') as HTMLElement;
    fireEvent.click(within(third).getByRole('button', { name: 'Skip' }));
    expect((within(third).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(third).getByText('Skipped: no answer is sent')).toBeTruthy();
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].body).toEqual({
      kind: 'questions',
      answers: [
        { id: 'q1', answer: '#ops' },
        { id: 'q2', answer: ['Mon', 'Wed'] },
        { id: 'q3', answer: null },
      ],
    });
    // sent once: the buttons are off now
    await waitFor(() => expect(send.disabled).toBe(true));
    fireEvent.click(send);
    expect(confirms()).toHaveLength(1);
  });

  it('sends a text answer, and Answer this takes a skip back', async () => {
    const card = questionsCard({
      details: { questions: [{ id: 'q1', question: 'Name of the sheet?', type: 'text' }] },
    });
    await open(card);
    withProviders(<QuestionsCard confirmation={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer this' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the sheet?' }), {
      target: { value: '  Leads 2026  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].body).toEqual({ kind: 'questions', answers: [{ id: 'q1', answer: 'Leads 2026' }] });
  });

  it('dismiss answers none of them', async () => {
    const card = questionsCard();
    await open(card);
    withProviders(<QuestionsCard confirmation={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].body).toEqual({ kind: 'questions', answers: [], dismissed: true });
  });

  it("keeps the Assistant's markup as text", () => {
    const card = questionsCard({
      title: `Title ${MARKUP}`,
      details: {
        introMessage: `Intro ${MARKUP}`,
        questions: [
          { id: 'q1', question: `Question ${MARKUP}`, type: 'single', options: [`Option ${MARKUP}`] },
        ],
      },
    });
    const { container } = withProviders(<QuestionsCard confirmation={card} />);
    expect(container.querySelector('img, b, script')).toBeNull();
    expect(screen.getByText(`Intro ${MARKUP}`)).toBeTruthy();
    expect(screen.getByText(`Question ${MARKUP}`)).toBeTruthy();
    expect(screen.getByText(`Option ${MARKUP}`)).toBeTruthy();
  });

  it('says so when the card is no longer open, and a timed out card is off', async () => {
    const card = questionsCard();
    withProviders(<QuestionsCard confirmation={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(
      () =>
        expect(useToastStore.getState().toasts.map((t) => t.description ?? '')).toContain(
          'This request is no longer open.',
        ),
      WAIT,
    );

    const old = questionsCard({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    withProviders(<QuestionsCard confirmation={old} />);
    expect(screen.getByText('This request timed out')).toBeTruthy();
  });
});

describe('TaskChecklist', () => {
  const tasks: AssistantTask[] = [
    { id: 't1', description: 'Read the sheet', status: 'done' },
    { id: 't2', description: 'Build the workflow', status: 'in_progress', detail: 'two nodes left' },
    { id: 't3', description: 'Test it', status: 'todo' },
    { id: 't4', description: 'Send a test email', status: 'failed', detail: 'SMTP refused' },
    { id: 't5', description: `Old step ${MARKUP}`, status: 'cancelled' },
  ];

  it('shows each state as text, the count and the details', () => {
    const { container } = withProviders(<TaskChecklist tasks={tasks} />);
    const list = screen.getByRole('region', { name: 'Tasks' });
    expect(within(list).getByText('Tasks: 1 of 5 done')).toBeTruthy();
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'done',
      'in_progress',
      'todo',
      'failed',
      'cancelled',
    ]);
    expect(items.map((item) => item.textContent)).toEqual([
      'Done: Read the sheet',
      'In progress: Build the workflowtwo nodes left',
      'To do: Test it',
      'Failed: Send a test emailSMTP refused',
      `Cancelled: Old step ${MARKUP}`,
    ]);
    expect(container.querySelector('img, b, script')).toBeNull();
    expect(items[1].querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the latest list from the store on the thread view', async () => {
    useAssistantStore.getState().setTasks(tasks.slice(0, 2));
    const { rerender } = withProviders(<TaskChecklist tasks={useAssistantStore.getState().tasks} />);
    expect(screen.getByText('Tasks: 1 of 2 done')).toBeTruthy();
    rerender(<TaskChecklist tasks={[{ ...tasks[1], status: 'done' }]} />);
    expect(screen.getByText('Tasks: 1 of 1 done')).toBeTruthy();
  });
});

describe('CredentialSetupCard', () => {
  it('uses an existing credential of the type and sends only its id', async () => {
    const first = await credentialsApi.create({
      name: 'Team login',
      type: 'httpBasicAuth',
      data: { user: 'a' },
    });
    const second = await credentialsApi.create({
      name: 'Ops login',
      type: 'httpBasicAuth',
      data: { user: 'b' },
    });
    await credentialsApi.create({ name: 'Cache', type: 'redis', data: {} });
    const card = credentialCard();
    await open(card);
    withProviders(<CredentialSetupCard confirmation={card} />);
    const group = screen.getByRole('group', { name: 'Set up a credential: Basic Auth' });
    expect(within(group).getByText('The request needs a login')).toBeTruthy();
    const select = (await within(group).findByRole(
      'combobox',
      { name: 'Credential to use' },
      WAIT,
    )) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Team login', 'Ops login']);
    expect(select.value).toBe(first.id);
    fireEvent.change(select, { target: { value: second.id } });
    fireEvent.click(within(group).getByRole('button', { name: 'Use this credential' }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].body).toEqual({ kind: 'credential', credentialId: second.id });
  });

  it('creates a new one in the credential dialog and answers once it closes', async () => {
    const card = credentialCard();
    await open(card);
    withProviders(<CredentialSetupCard confirmation={card} />);
    // no credential of the type yet: no picker
    expect(screen.queryByRole('combobox', { name: 'Credential to use' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create a new one' }));
    expect(await screen.findByText('New Basic Auth', {}, WAIT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    const created = backend().credentials.find((c) => c.type === 'httpBasicAuth');
    expect(created).toBeTruthy();
    expect(confirms()[0].body).toEqual({ kind: 'credential', credentialId: created?.id });
  });

  it('skip sends no credential', async () => {
    const card = credentialCard({ details: { credentialType: 'httpBasicAuth' } });
    await open(card);
    withProviders(<CredentialSetupCard confirmation={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(confirms()).toHaveLength(1), WAIT);
    expect(confirms()[0].body).toEqual({ kind: 'credential', credentialId: null });
  });
});
