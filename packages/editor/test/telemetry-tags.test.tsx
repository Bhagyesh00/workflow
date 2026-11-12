/**
 * P6-67 (S5 L11): the custom telemetry attribute field and its three slots (workflow settings, node settings,
 * project settings): add, edit and remove rows; an empty or a duplicate key is refused (nothing is passed on, the
 * reason is shown); a disabled or read-only field cannot be changed; each wrapper writes its own shape.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TELEMETRY_TAG_LIMITS, type WorkflowNode, type WorkflowSettings } from '@workflow/workflow';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { TelemetryTag } from '../src/api/types';
import { NodeTelemetryTags } from '../src/components/telemetry/NodeTelemetryTags';
import { ProjectTelemetryTags } from '../src/components/telemetry/ProjectTelemetryTags';
import { TelemetryTagsField } from '../src/components/telemetry/TelemetryTagsField';
import { WorkflowTelemetryTags } from '../src/components/telemetry/WorkflowTelemetryTags';
import { withProviders } from './utils';

function FieldHarness({
  initial,
  seen,
  disabled,
}: {
  initial: TelemetryTag[];
  seen: TelemetryTag[][];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TelemetryTagsField
      value={value}
      disabled={disabled}
      onChange={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />
  );
}

function OutsideHarness() {
  const [value, setValue] = useState<TelemetryTag[]>([{ key: 'a', value: '1' }]);
  return (
    <>
      <button type="button" onClick={() => setValue([{ key: 'z', value: '9' }])}>
        Load other
      </button>
      <TelemetryTagsField value={value} onChange={setValue} />
    </>
  );
}

function WorkflowHarness({ seen, initial }: { seen: WorkflowSettings[]; initial: WorkflowSettings }) {
  const [draft, setDraft] = useState(initial);
  return (
    <WorkflowTelemetryTags
      draft={draft}
      set={(patch) => {
        const next = { ...draft, ...patch };
        seen.push(next);
        setDraft(next);
      }}
    />
  );
}

const baseNode: WorkflowNode = {
  id: 'n1',
  name: 'Set',
  type: 'core.set',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function NodeHarness({
  seen,
  initial = baseNode,
  readOnly = false,
}: {
  seen: Array<Partial<WorkflowNode>>;
  initial?: WorkflowNode;
  readOnly?: boolean;
}) {
  const [node, setNode] = useState(initial);
  return (
    <NodeTelemetryTags
      node={node}
      readOnly={readOnly}
      onChange={(patch) => {
        seen.push(patch);
        setNode({ ...node, ...patch });
      }}
    />
  );
}

describe('TelemetryTagsField', () => {
  it('shows the stored rows, adds a row, edits it and passes the list on', async () => {
    const seen: TelemetryTag[][] = [];
    withProviders(<FieldHarness initial={[{ key: 'region', value: 'eu' }]} seen={seen} />);
    const user = userEvent.setup();
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('region');
    expect((screen.getByLabelText('Value 1') as HTMLInputElement).value).toBe('eu');

    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(seen).toHaveLength(0);
    await user.type(screen.getByLabelText('Key 2'), ' team ');
    await user.type(screen.getByLabelText('Value 2'), 'core');
    expect(seen.at(-1)).toEqual([
      { key: 'region', value: 'eu' },
      { key: 'team', value: 'core' },
    ]);
  });

  it('removes a row', async () => {
    const seen: TelemetryTag[][] = [];
    withProviders(
      <FieldHarness
        initial={[
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ]}
        seen={seen}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove attribute 1' }));
    expect(seen.at(-1)).toEqual([{ key: 'b', value: '2' }]);
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('b');
    await user.click(screen.getByRole('button', { name: 'Remove attribute 1' }));
    expect(seen.at(-1)).toEqual([]);
    expect(screen.queryByLabelText('Key 1')).toBeNull();
  });

  it('refuses a duplicate key: the reason shows and the list is not passed on', async () => {
    const seen: TelemetryTag[][] = [];
    withProviders(<FieldHarness initial={[{ key: 'region', value: 'eu' }]} seen={seen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.type(screen.getByLabelText('Key 2'), 'region');
    await user.type(screen.getByLabelText('Value 2'), 'us');
    expect(screen.getByRole('alert').textContent).toContain('region');
    expect(screen.getByRole('alert').textContent).toContain('more than once');
    expect(seen.every((list) => new Set(list.map((t) => t.key)).size === list.length)).toBe(true);
    expect(seen.some((list) => list.some((t) => t.value === 'us'))).toBe(false);

    // changing the key clears the problem and passes the list on
    await user.type(screen.getByLabelText('Key 2'), '2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(seen.at(-1)).toEqual([
      { key: 'region', value: 'eu' },
      { key: 'region2', value: 'us' },
    ]);
  });

  it('refuses an empty key that has a value, and ignores a row that is still blank', async () => {
    const seen: TelemetryTag[][] = [];
    withProviders(<FieldHarness initial={[]} seen={seen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByLabelText('Value 1'), 'orphan');
    expect(screen.getByRole('alert').textContent).toMatch(/needs a key/);
    expect(seen).toHaveLength(0);
    await user.type(screen.getByLabelText('Key 1'), '   ');
    expect(screen.getByRole('alert').textContent).toMatch(/needs a key/);
    expect(seen).toHaveLength(0);
    await user.type(screen.getByLabelText('Key 1'), 'k');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(seen.at(-1)).toEqual([{ key: 'k', value: 'orphan' }]);
  });

  it('stops adding at the limit, and bounds a key and a value', () => {
    const full = Array.from({ length: TELEMETRY_TAG_LIMITS.max }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    withProviders(<FieldHarness initial={full} seen={[]} />);
    expect((screen.getByRole('button', { name: 'Add attribute' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).maxLength).toBe(
      TELEMETRY_TAG_LIMITS.keyLength,
    );
    expect((screen.getByLabelText('Value 1') as HTMLInputElement).maxLength).toBe(
      TELEMETRY_TAG_LIMITS.valueLength,
    );
  });

  it('a disabled field shows the rows and changes nothing', () => {
    const seen: TelemetryTag[][] = [];
    withProviders(<FieldHarness initial={[{ key: 'region', value: 'eu' }]} seen={seen} disabled />);
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Value 1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add attribute' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Remove attribute 1' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(seen).toHaveLength(0);
  });

  it('takes a new list from outside', async () => {
    withProviders(<OutsideHarness />);
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('a');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load other' }));
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('z');
    expect((screen.getByLabelText('Value 1') as HTMLInputElement).value).toBe('9');
  });
});

describe('WorkflowTelemetryTags', () => {
  it('reads and writes settings.customTelemetryTags and names the span prefix', async () => {
    const seen: WorkflowSettings[] = [];
    withProviders(
      <WorkflowHarness seen={seen} initial={{ customTelemetryTags: [{ key: 'area', value: 'billing' }] }} />,
    );
    const user = userEvent.setup();
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('area');
    expect(screen.getByText(/workflow\.custom\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.type(screen.getByLabelText('Key 2'), 'tier');
    expect(seen.at(-1)?.customTelemetryTags).toEqual([
      { key: 'area', value: 'billing' },
      { key: 'tier', value: '' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove attribute 2' }));
    await user.click(screen.getByRole('button', { name: 'Remove attribute 1' }));
    expect(seen.at(-1)?.customTelemetryTags).toBeUndefined();
  });
});

describe('NodeTelemetryTags', () => {
  it('writes node.customTelemetryTags as { tag }, values are expressions, and clears it when empty', async () => {
    const seen: Array<Partial<WorkflowNode>> = [];
    withProviders(<NodeHarness seen={seen} />);
    const user = userEvent.setup();
    expect(screen.getByText(/node\.custom\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.type(screen.getByLabelText('Key 1'), 'plan');
    await user.type(screen.getByLabelText('Value 1'), '={{{{ $json.plan }}');
    expect(seen.at(-1)).toEqual({
      customTelemetryTags: { tag: [{ key: 'plan', value: '={{ $json.plan }}' }] },
    });
    await user.click(screen.getByRole('button', { name: 'Remove attribute 1' }));
    expect(seen.at(-1)).toEqual({ customTelemetryTags: undefined });
  });

  it('shows stored tags and is read only on a protected workspace', () => {
    const seen: Array<Partial<WorkflowNode>> = [];
    withProviders(
      <NodeHarness
        seen={seen}
        readOnly
        initial={{ ...baseNode, customTelemetryTags: { tag: [{ key: 'plan', value: 'pro' }] } }}
      />,
    );
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).value).toBe('plan');
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add attribute' }) as HTMLButtonElement).disabled).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe('ProjectTelemetryTags', () => {
  it('passes the list through and names the span prefix', async () => {
    const seen: TelemetryTag[][] = [];
    const { container } = withProviders(
      <ProjectTelemetryTags value={[{ key: 'region', value: 'eu' }]} onChange={(next) => seen.push(next)} />,
    );
    const user = userEvent.setup();
    expect(within(container).getByText(/project\.custom\./)).toBeTruthy();
    await user.type(screen.getByLabelText('Value 1'), '1');
    expect(seen.at(-1)).toEqual([{ key: 'region', value: 'eu1' }]);
  });

  it('is disabled for a viewer', () => {
    withProviders(
      <ProjectTelemetryTags value={[{ key: 'region', value: 'eu' }]} onChange={() => {}} disabled />,
    );
    expect((screen.getByLabelText('Key 1') as HTMLInputElement).disabled).toBe(true);
  });
});
