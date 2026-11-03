import { describe, expect, it } from 'vitest';
import {
  type CompactionVersion,
  type Connections,
  isAdditiveChange,
  OPTIMIZE_MAX_GAP_MS,
  selectRedundantVersions,
  trimBucketMs,
  type WorkflowNode,
} from '../src';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-03T12:00:00.000Z');

const ago = (ms: number) => new Date(NOW.getTime() - ms);

function setNode(value: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'n-set',
    name: 'Set',
    type: 'core.set',
    typeVersion: 1,
    position: [200, 0],
    parameters: { value },
    ...extra,
  };
}

const trigger: WorkflowNode = {
  id: 'n-trigger',
  name: 'Trigger',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const linked: Connections = { Trigger: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } };

let seq = 0;
function version(createdAt: Date, partial: Partial<CompactionVersion> = {}): CompactionVersion {
  seq++;
  return {
    id: `v${seq}`,
    createdAt,
    authorId: 'u1',
    versionName: null,
    description: null,
    autosaved: true,
    nodes: [trigger],
    connections: {},
    ...partial,
  };
}

describe('isAdditiveChange', () => {
  it('a new node, a new connection or longer text only adds', () => {
    const before = { nodes: [trigger], connections: {} };
    expect(isAdditiveChange(before, { nodes: [trigger, setNode('a')], connections: {} })).toBe(true);
    const two = { nodes: [trigger, setNode('a')], connections: {} };
    expect(isAdditiveChange(two, { nodes: [trigger, setNode('a')], connections: linked })).toBe(true);
    expect(isAdditiveChange(two, { nodes: [trigger, setNode('abc')], connections: {} })).toBe(true);
    // moving a node is layout, not content
    expect(
      isAdditiveChange(two, { nodes: [trigger, setNode('a', { position: [400, 80] })], connections: {} }),
    ).toBe(true);
  });

  it('a removed node or connection, changed text, a rename or a new type is not additive', () => {
    const two = { nodes: [trigger, setNode('abc')], connections: linked };
    expect(isAdditiveChange(two, { nodes: [setNode('abc')], connections: {} })).toBe(false);
    expect(isAdditiveChange(two, { nodes: two.nodes, connections: {} })).toBe(false);
    expect(isAdditiveChange(two, { nodes: [trigger, setNode('ab')], connections: linked })).toBe(false);
    expect(isAdditiveChange(two, { nodes: [trigger, setNode('xbc')], connections: linked })).toBe(false);
    expect(
      isAdditiveChange(two, { nodes: [trigger, setNode('abc', { name: 'Set 2' })], connections: linked }),
    ).toBe(false);
    expect(
      isAdditiveChange(two, { nodes: [trigger, setNode('abc', { typeVersion: 2 })], connections: linked }),
    ).toBe(false);
    expect(
      isAdditiveChange(two, { nodes: [trigger, setNode('abc', { disabled: true })], connections: linked }),
    ).toBe(true);
    expect(
      isAdditiveChange(
        { nodes: [setNode('abc', { disabled: true })], connections: {} },
        { nodes: [setNode('abc', { disabled: false })], connections: {} },
      ),
    ).toBe(false);
  });
});

describe('isAdditiveChange (workflow fields)', () => {
  const base = { nodes: [trigger], connections: {} };

  it('a changed setting, a removed sticky or group, or a rename is not additive', () => {
    expect(
      isAdditiveChange(
        { ...base, settings: { timezone: 'Europe/Berlin' } },
        { ...base, settings: { timezone: 'UTC' } },
      ),
    ).toBe(false);
    expect(
      isAdditiveChange(
        { ...base, stickyNotes: [{ id: 's1', content: 'Note' }] },
        { ...base, stickyNotes: [] },
      ),
    ).toBe(false);
    expect(
      isAdditiveChange(
        { ...base, nodeGroups: [{ id: 'g1', name: 'Group', nodeIds: ['n-trigger'] }] },
        { ...base, nodeGroups: [] },
      ),
    ).toBe(false);
    expect(isAdditiveChange({ ...base, name: 'Orders' }, { ...base, name: 'Invoices' })).toBe(false);
  });

  it('a new setting, sticky or group only adds; fields a caller leaves out do not count', () => {
    expect(
      isAdditiveChange({ ...base, settings: {} }, { ...base, settings: { timezone: 'UTC' } }),
    ).toBe(true);
    expect(
      isAdditiveChange(
        { ...base, stickyNotes: [], nodeGroups: [] },
        { ...base, stickyNotes: [{ id: 's1' }], nodeGroups: [{ id: 'g1' }] },
      ),
    ).toBe(true);
    expect(isAdditiveChange(base, { ...base, settings: { timezone: 'UTC' } })).toBe(true);
  });

  it('optimize keeps a version whose successor changes a setting', () => {
    const a = version(ago(60 * MIN), { settings: { timezone: 'Europe/Berlin' } });
    const b = version(ago(58 * MIN), {
      nodes: [trigger, setNode('a')],
      settings: { timezone: 'UTC' },
      isCurrent: true,
    });
    expect(selectRedundantVersions([a, b], { mode: 'optimize', now: NOW })).toEqual([]);
  });
});

describe('selectRedundantVersions (optimize)', () => {
  it('drops a version whose successor only adds to it within 20 minutes', () => {
    const a = version(ago(60 * MIN), { nodes: [trigger] });
    const b = version(ago(55 * MIN), { nodes: [trigger, setNode('a')] });
    const c = version(ago(50 * MIN), { nodes: [trigger, setNode('abc')], connections: linked, isCurrent: true });
    expect(selectRedundantVersions([c, a, b], { mode: 'optimize', now: NOW }).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it('keeps a version when the gap to its successor is 20 minutes or more', () => {
    const a = version(ago(90 * MIN));
    const b = version(ago(90 * MIN - OPTIMIZE_MAX_GAP_MS), { nodes: [trigger, setNode('a')], isCurrent: true });
    expect(selectRedundantVersions([a, b], { mode: 'optimize', now: NOW })).toEqual([]);
  });

  it('keeps a version when the successor removes or changes something', () => {
    const a = version(ago(60 * MIN), { nodes: [trigger, setNode('abc')] });
    const b = version(ago(58 * MIN), { nodes: [trigger, setNode('ab')] });
    const c = version(ago(56 * MIN), { nodes: [setNode('ab')], isCurrent: true });
    expect(selectRedundantVersions([a, b, c], { mode: 'optimize', now: NOW })).toEqual([]);
  });

  it('only looks at versions 0.25 to 2.25 hours old', () => {
    // `tooOld` is older than 2.25 h; `old` is in the window but its successor is 1 h 50 min later
    const tooOld = version(ago(2.5 * HOUR));
    const old = version(ago(2.5 * HOUR - 5 * MIN), { nodes: [trigger, setNode('a')] });
    const inWindow = version(ago(2 * HOUR), { nodes: [trigger, setNode('ab')] });
    const fresh = version(ago(10 * MIN), { nodes: [trigger, setNode('abc')] });
    const current = version(ago(5 * MIN), { nodes: [trigger, setNode('abcd')], isCurrent: true });
    expect(
      selectRedundantVersions([tooOld, old, inWindow, fresh, current], { mode: 'optimize', now: NOW }),
    ).toEqual([]);
    // a version 20 min old goes; one 12 min old is too young, even when its successor only adds to it
    const a = version(ago(20 * MIN));
    const b = version(ago(14 * MIN), { nodes: [trigger, setNode('a')], isCurrent: true });
    expect(selectRedundantVersions([a, b], { mode: 'optimize', now: NOW })).toEqual([a.id]);
    const c = version(ago(12 * MIN));
    const d = version(ago(6 * MIN), { nodes: [trigger, setNode('a')], isCurrent: true });
    expect(selectRedundantVersions([c, d], { mode: 'optimize', now: NOW })).toEqual([]);
  });

  it('never drops the current, published, named or described version', () => {
    const base = (partial: Partial<CompactionVersion>) => [
      version(ago(60 * MIN), partial),
      version(ago(58 * MIN), { nodes: [trigger, setNode('a')], isCurrent: true }),
    ];
    for (const partial of [
      { isPublished: true },
      { versionName: 'Before the API change' },
      { description: 'kept on purpose' },
      { description: '' },
    ]) {
      expect(selectRedundantVersions(base(partial), { mode: 'optimize', now: NOW })).toEqual([]);
    }
    // the newest version has no successor: nothing contains it
    expect(
      selectRedundantVersions([version(ago(60 * MIN)), version(ago(58 * MIN), { nodes: [trigger, setNode('a')] })], {
        mode: 'optimize',
        now: NOW,
      }),
    ).toHaveLength(1);
    expect(
      selectRedundantVersions([version(ago(60 * MIN), { isCurrent: true })], { mode: 'optimize', now: NOW }),
    ).toEqual([]);
  });

  it('never drops a version followed by another author', () => {
    const a = version(ago(60 * MIN), { authorId: 'u1' });
    const b = version(ago(58 * MIN), { authorId: 'u2', nodes: [trigger, setNode('a')], isCurrent: true });
    expect(selectRedundantVersions([a, b], { mode: 'optimize', now: NOW })).toEqual([]);
  });

  it('honours a custom window', () => {
    const a = version(ago(5 * HOUR));
    const b = version(ago(5 * HOUR - MIN), { nodes: [trigger, setNode('a')], isCurrent: true });
    expect(selectRedundantVersions([a, b], { mode: 'optimize', now: NOW })).toEqual([]);
    expect(
      selectRedundantVersions([a, b], { mode: 'optimize', now: NOW, minimumAgeMs: HOUR, windowMs: 5 * HOUR }),
    ).toEqual([a.id]);
  });
});

describe('selectRedundantVersions (trim)', () => {
  it('bucket size grows with the number of versions', () => {
    expect(trimBucketMs(0)).toBe(MIN);
    expect(trimBucketMs(99)).toBe(MIN);
    expect(trimBucketMs(100)).toBe(10 * MIN);
    expect(trimBucketMs(1000)).toBe(2 * HOUR);
    expect(trimBucketMs(5000)).toBe(5 * HOUR);
    expect(trimBucketMs(10_000)).toBe(10 * HOUR);
    expect(trimBucketMs(50_000)).toBe(10 * HOUR);
  });

  it('keeps the newest version of each minute in versions 6 to 8 days old', () => {
    const start = new Date(Date.UTC(2026, 9, 27, 10, 0, 0)); // 7 days and 2 hours before NOW
    const at = (s: number) => new Date(start.getTime() + s * 1000);
    // minute 1: three versions; minute 2: two; the content does not matter for trim
    const m1 = [version(at(5), { nodes: [] }), version(at(20)), version(at(50), { nodes: [setNode('x')] })];
    const m2 = [version(at(70)), version(at(110))];
    const current = version(ago(MIN), { isCurrent: true });
    const dropped = selectRedundantVersions([...m1, ...m2, current], { mode: 'trim', now: NOW });
    expect(dropped.sort()).toEqual([m1[0].id, m1[1].id, m2[0].id].sort());
  });

  it('never drops protected versions or one followed by another author', () => {
    const start = new Date(Date.UTC(2026, 9, 27, 10, 0, 0));
    const at = (s: number) => new Date(start.getTime() + s * 1000);
    const named = version(at(1), { versionName: 'v1' });
    const described = version(at(2), { description: 'note' });
    const published = version(at(3), { isPublished: true });
    const beforeOther = version(at(4), { authorId: 'u1' });
    const other = version(at(5), { authorId: 'u2' });
    const plain = version(at(6), { authorId: 'u2' });
    const last = version(at(7), { authorId: 'u2' });
    const current = version(ago(MIN), { isCurrent: true, authorId: 'u2' });
    const dropped = selectRedundantVersions([named, described, published, beforeOther, other, plain, last, current], {
      mode: 'trim',
      now: NOW,
    });
    expect(dropped.sort()).toEqual([other.id, plain.id].sort());
  });

  it('leaves versions outside 6 to 8 days alone', () => {
    const recent = [version(ago(5 * DAY)), version(ago(5 * DAY - 1000))];
    const ancient = [version(ago(9 * DAY)), version(ago(9 * DAY - 1000))];
    const current = version(ago(MIN), { isCurrent: true });
    expect(selectRedundantVersions([...ancient, ...recent, current], { mode: 'trim', now: NOW })).toEqual([]);
  });

  it('uses bigger buckets when a workflow has many versions in the window', () => {
    const start = new Date(Date.UTC(2026, 9, 27, 10, 0, 0));
    // 120 versions, one every 30 s over one hour: 10-minute buckets keep 6
    const many = Array.from({ length: 120 }, (_, i) => version(new Date(start.getTime() + i * 30_000)));
    const current = version(ago(MIN), { isCurrent: true });
    const dropped = selectRedundantVersions([...many, current], { mode: 'trim', now: NOW });
    expect(dropped).toHaveLength(114);
    expect(dropped).not.toContain(many[119].id);
    expect(dropped).not.toContain(current.id);
  });
});
