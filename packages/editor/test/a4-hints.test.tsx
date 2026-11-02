import { render, screen, within } from '@testing-library/react';
import type { RunData, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { OutputPane } from '../src/components/ndv/DataPanes';
import type { NodePorts } from '../src/lib/ports';

const node: WorkflowNode = {
  id: 'n1',
  name: 'Split',
  type: 'core.splitOut',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const ports: NodePorts = {
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  isSubNode: false,
  isTrigger: false,
} as NodePorts;

function pane(runData: RunData) {
  return render(
    <OutputPane
      node={node}
      ports={ports}
      runData={runData}
      previousRunData={null}
      readOnly={false}
      running={false}
      onPin={() => undefined}
    />,
  );
}

function task(extra: Partial<RunData[string][number]>): RunData[string][number] {
  return {
    startTime: 1,
    executionTime: 5,
    executionStatus: 'success',
    data: { main: [[{ json: { id: 1 } }]] },
    source: [],
    ...extra,
  };
}

describe('R61: execution hints in the output pane', () => {
  it('shows each hint of the selected run above the output data', () => {
    pane({
      Split: [
        task({
          hints: [
            { message: "The field 'lines' wasn't found in any input item", level: 'warning' },
            { message: 'Items were routed to the error output', level: 'info' },
            { message: 'No level given' },
          ],
        }),
      ],
    });
    const hints = screen.getByRole('list', { name: 'Execution hints' });
    const entries = within(hints).getAllByRole('listitem');
    expect(entries.map((e) => e.textContent)).toEqual([
      "The field 'lines' wasn't found in any input item",
      'Items were routed to the error output',
      'No level given',
    ]);
    expect(entries[0]?.firstElementChild?.className).toContain('bg-warn-soft');
    expect(entries[1]?.firstElementChild?.className).toContain('bg-brand-soft');
    expect(entries[2]?.firstElementChild?.className).toContain('bg-brand-soft');
  });

  it('shows the hints of the run that is selected, not of the other runs', () => {
    pane({
      Split: [task({ hints: [{ message: 'First run hint', level: 'info' }] }), task({})],
    });
    expect(screen.queryByText('First run hint')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Execution hints' })).toBeNull();
  });

  it('shows no hints block when the run has none', () => {
    pane({ Split: [task({})] });
    expect(screen.queryByRole('list', { name: 'Execution hints' })).toBeNull();
  });
});
