/**
 * P6-56 (L12): the Time Saved settings fields: Fixed and Dynamic tabs, the minutes input, and the notices when
 * the mode and the open workflow's Track Time Saved nodes disagree.
 */
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowSettings } from '@workflow/workflow';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TimeSavedFields } from '../src/components/workflow/TimeSavedFields';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { withProviders } from './utils';

function Harness({
  initial,
  onChange,
}: {
  initial: WorkflowSettings;
  onChange: (s: WorkflowSettings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <TimeSavedFields
      draft={draft}
      set={(patch) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onChange(next);
      }}
    />
  );
}

function openWorkflow(nodes: Array<{ type: string; disabled?: boolean }>) {
  act(() => {
    useWorkflowStore.getState().load({
      id: 'wf-ts',
      name: 'Time saved flow',
      nodes: nodes.map((n, i) => ({
        id: `n${i}`,
        name: `Node ${i}`,
        type: n.type,
        typeVersion: 1,
        position: [i * 100, 0],
        parameters: {},
        disabled: n.disabled,
      })),
      connections: {},
    });
  });
}

afterEach(() => {
  act(() => {
    useWorkflowStore.getState().load({ name: 'My workflow', nodes: [], connections: {} });
  });
});

describe('TimeSavedFields', () => {
  it('shows Fixed by default with the minutes, and writes a whole number of minutes', async () => {
    openWorkflow([]);
    const seen: WorkflowSettings[] = [];
    withProviders(<Harness initial={{ timeSavedPerExecution: 5 }} onChange={(s) => seen.push(s)} />);
    const user = userEvent.setup();
    expect(screen.getByRole('tab', { name: 'Fixed' }).getAttribute('aria-selected')).toBe('true');
    const input = screen.getByLabelText('Minutes saved per run') as HTMLInputElement;
    expect(input.value).toBe('5');
    await user.clear(input);
    expect(seen.at(-1)?.timeSavedPerExecution).toBeUndefined();
    await user.type(input, '12');
    expect(seen.at(-1)?.timeSavedPerExecution).toBe(12);
    await user.clear(input);
    await user.type(input, '-3');
    expect(seen.every((s) => (s.timeSavedPerExecution ?? 0) >= 0)).toBe(true);
  });

  it('switches to Dynamic and back, and keeps the fixed number', async () => {
    openWorkflow([]);
    const seen: WorkflowSettings[] = [];
    withProviders(<Harness initial={{ timeSavedPerExecution: 7 }} onChange={(s) => seen.push(s)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Dynamic' }));
    expect(seen.at(-1)).toMatchObject({ timeSavedMode: 'dynamic', timeSavedPerExecution: 7 });
    expect(screen.queryByLabelText('Minutes saved per run')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Fixed' }));
    expect(seen.at(-1)?.timeSavedMode).toBe('fixed');
    expect((screen.getByLabelText('Minutes saved per run') as HTMLInputElement).value).toBe('7');
  });

  it('Dynamic with no Track Time Saved node warns that a run saves no time', () => {
    openWorkflow([{ type: 'core.set' }, { type: 'core.timeSaved', disabled: true }]);
    withProviders(<Harness initial={{ timeSavedMode: 'dynamic' }} onChange={() => undefined} />);
    expect(screen.getByText('No Track Time Saved node')).toBeTruthy();
  });

  it('Dynamic with nodes says how many are added up', () => {
    openWorkflow([{ type: 'core.timeSaved' }, { type: 'core.timeSaved' }, { type: 'core.set' }]);
    withProviders(<Harness initial={{ timeSavedMode: 'dynamic' }} onChange={() => undefined} />);
    expect(screen.getByText(/minutes of 2 Track Time Saved nodes are added up/)).toBeTruthy();
    expect(screen.queryByText('No Track Time Saved node')).toBeNull();
  });

  it('Fixed with Track Time Saved nodes warns that they are ignored', () => {
    openWorkflow([{ type: 'core.timeSaved' }]);
    withProviders(<Harness initial={{ timeSavedMode: 'fixed' }} onChange={() => undefined} />);
    expect(screen.getByText('Track Time Saved nodes are ignored')).toBeTruthy();
    expect(screen.getByText(/has 1 Track Time Saved node\./)).toBeTruthy();
  });

  it('Fixed with no such node shows no notice, and the arrow keys move between the tabs', async () => {
    openWorkflow([{ type: 'core.set' }]);
    const seen: WorkflowSettings[] = [];
    withProviders(<Harness initial={{}} onChange={(s) => seen.push(s)} />);
    expect(screen.queryByText('Track Time Saved nodes are ignored')).toBeNull();
    const user = userEvent.setup();
    screen.getByRole('tab', { name: 'Fixed' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(seen.at(-1)?.timeSavedMode).toBe('dynamic');
  });
});
