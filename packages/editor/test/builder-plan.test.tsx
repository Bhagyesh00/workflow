/**
 * P5-63 plan mode in the builder panel: the toggle sends `mode: 'plan'`, the planner's questions are
 * answered and sent as `resumeData.answers`, a plan has Approve (the mode moves to build), Modify (with
 * feedback) and Reject, and a plan with HTML stays text.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BuilderChunk, BuilderPlan, BuilderQuestion, BuildRequest } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BuildStreamConnector, setBuildStreamConnector } from '../src/api/ai-stream';
import { useBuilderStore } from '../src/stores/builder-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const QUESTIONS: BuilderQuestion[] = [
  { id: 'channel', question: 'Where should it go?', type: 'single', options: ['Slack', 'Email'] },
  { id: 'extras', question: 'Which extras?', type: 'multi', options: ['Log', 'Retry', 'Alert'] },
  { id: 'detail', question: 'Anything else?', type: 'text' },
];

const PLAN: BuilderPlan = {
  summary: 'Greet the world on a manual run',
  trigger: 'Manual trigger',
  steps: [
    { description: 'Start by hand', nodeTypes: ['core.manualTrigger'] },
    { description: 'Set a greeting field', nodeTypes: ['core.set'] },
  ],
  notes: ['No credentials needed'],
};

/** plays `chunks` for every turn and records each request body */
function scripted(chunks: BuilderChunk[]): BuildRequest[] {
  const bodies: BuildRequest[] = [];
  const connector: BuildStreamConnector = async (body, onChunk) => {
    bodies.push(body);
    for (const chunk of chunks) {
      onChunk(chunk);
      await Promise.resolve();
    }
  };
  setBuildStreamConnector(connector);
  return bodies;
}

async function openPanel() {
  const wf = backend().seedWorkflow({ name: 'Plan me', nodes: [], connections: {} });
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  const user = userEvent.setup();
  const [entry] = await screen.findAllByRole('button', { name: 'Build with AI' });
  await user.click(entry);
  const panel = await screen.findByRole('complementary', { name: 'AI builder' });
  return { user, panel };
}

async function sendText(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, text: string) {
  await user.type(within(panel).getByRole('textbox', { name: 'Message the AI builder' }), text);
  await user.click(within(panel).getByRole('button', { name: 'Send' }));
}

describe('plan mode in the builder panel (P5-63)', () => {
  beforeEach(() => {
    signedIn();
    useBuilderStore.getState().reset();
  });
  afterEach(() => {
    setBuildStreamConnector(null);
    useBuilderStore.getState().reset();
  });

  it('the toggle switches the mode and the request carries it', async () => {
    const { user, panel } = await openPanel();
    const toggle = within(panel).getByRole('switch', { name: 'Plan mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(useBuilderStore.getState().mode).toBe('plan');
    const bodies = scripted([{ type: 'message', id: 'a', text: 'Planning' }]);
    await sendText(user, panel, 'Greet');
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.mode).toBe('plan');
  });

  it('questions are answered and sent as resumeData.answers in plan mode', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('switch', { name: 'Plan mode' }));
    scripted([{ type: 'questions', questions: QUESTIONS }]);
    await sendText(user, panel, 'Greet');
    const form = await within(panel).findByRole('form', { name: 'Questions from the planner' });
    const send = within(form).getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await user.click(within(form).getByRole('radio', { name: 'Email' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Log' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Alert' }));
    await user.type(within(form).getByRole('textbox', { name: 'Anything else?' }), 'Daily');
    expect(send.disabled).toBe(false);

    const bodies = scripted([{ type: 'plan', plan: PLAN }]);
    await user.click(send);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.mode).toBe('plan');
    expect(bodies[0]?.resumeData).toEqual({
      answers: [
        { id: 'channel', answer: 'Email' },
        { id: 'extras', answer: 'Log, Alert' },
        { id: 'detail', answer: 'Daily' },
      ],
    });
    expect(await within(panel).findByRole('region', { name: 'Plan' })).toBeTruthy();
    expect(within(panel).queryByRole('form', { name: 'Questions from the planner' })).toBeNull();
  });

  it('Approve moves to build mode and sends the decision', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('switch', { name: 'Plan mode' }));
    scripted([{ type: 'plan', plan: PLAN }]);
    await sendText(user, panel, 'Greet');
    const plan = await within(panel).findByRole('region', { name: 'Plan' });
    expect(within(plan).getByText(PLAN.summary)).toBeTruthy();
    expect(within(plan).getByText('Set a greeting field')).toBeTruthy();
    expect(within(plan).getByText('core.set')).toBeTruthy();
    expect(within(plan).getByText('No credentials needed')).toBeTruthy();

    const bodies = scripted([{ type: 'message', id: 'b', text: 'Building' }]);
    await user.click(within(plan).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.resumeData).toEqual({ planDecision: 'approve' });
    expect(bodies[0]?.mode).toBe('build');
    expect(useBuilderStore.getState().mode).toBe('build');
  });

  it('Modify needs feedback and sends it; the mode stays plan', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('switch', { name: 'Plan mode' }));
    scripted([{ type: 'plan', plan: PLAN }]);
    await sendText(user, panel, 'Greet');
    const plan = await within(panel).findByRole('region', { name: 'Plan' });

    await user.click(within(plan).getByRole('button', { name: 'Modify' }));
    const submit = within(plan).getByRole('button', { name: 'Send changes' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(
      within(plan).getByRole('textbox', { name: 'What should change in the plan' }),
      'Use email',
    );
    const bodies = scripted([{ type: 'plan', plan: { ...PLAN, summary: 'Greet by email' } }]);
    await user.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.resumeData).toEqual({ planDecision: 'modify', feedback: 'Use email' });
    expect(bodies[0]?.mode).toBe('plan');
    expect(await within(panel).findByText('Greet by email')).toBeTruthy();
  });

  it('Reject sends the decision and the plan goes away', async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('switch', { name: 'Plan mode' }));
    scripted([{ type: 'plan', plan: PLAN }]);
    await sendText(user, panel, 'Greet');
    const plan = await within(panel).findByRole('region', { name: 'Plan' });

    const bodies = scripted([{ type: 'message', id: 'r', text: 'Plan rejected.' }]);
    await user.click(within(plan).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.resumeData).toEqual({ planDecision: 'reject' });
    await waitFor(() => expect(within(panel).queryByRole('region', { name: 'Plan' })).toBeNull());
    expect(useBuilderStore.getState().reviewing).toBe(false);
  });

  it('a plan with HTML stays text', async () => {
    const { user, panel } = await openPanel();
    scripted([
      {
        type: 'plan',
        plan: {
          summary: '<img src="x" onerror="alert(1)">Evil summary',
          steps: [{ description: '<script>alert(2)</script>' }],
        },
      },
    ]);
    await sendText(user, panel, 'Greet');
    const plan = await within(panel).findByRole('region', { name: 'Plan' });
    expect(plan.querySelector('img, script')).toBeNull();
    expect(within(plan).getByText(/<img src="x"/)).toBeTruthy();
  });
});
