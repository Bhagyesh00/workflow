/** Phase 6 S3 contract step, C0a: the redaction policy math, sub-workflow reports and the new type fields. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  floorToChannels,
  isWeakerThanFloor,
  mergeChannels,
  type NodeTypeDescription,
  nodeCredentialIds,
  policyToChannels,
  type RedactionChannels,
  type RedactionFloor,
  type RedactionPolicy,
  type RunData,
  reportedChannels,
  reportedCredentialIds,
  type SubWorkflowReport,
  type TaskData,
  type WorkflowNode,
  type WorkflowSettings,
} from '../src';

const POLICIES: RedactionPolicy[] = ['none', 'manual-only', 'non-manual', 'all'];
const FLOORS: RedactionFloor[] = ['off', 'production', 'all'];

function task(metadata?: TaskData['metadata']): TaskData {
  return { startTime: 0, executionTime: 1, executionStatus: 'success', source: [], metadata };
}

function node(name: string, credentials?: WorkflowNode['credentials']): WorkflowNode {
  return { id: name, name, type: 'core.noOp', typeVersion: 1, position: [0, 0], parameters: {}, credentials };
}

describe('redaction policy channels', () => {
  it('maps the four policies to their channels', () => {
    expect(Object.fromEntries(POLICIES.map((p) => [p, policyToChannels(p)]))).toEqual({
      none: { production: false, manual: false },
      'manual-only': { production: false, manual: true },
      'non-manual': { production: true, manual: false },
      all: { production: true, manual: true },
    });
    expect(policyToChannels(undefined)).toEqual({ production: false, manual: false });
  });

  it('maps the three floors to their channels', () => {
    expect(floorToChannels('off')).toEqual({ production: false, manual: false });
    expect(floorToChannels('production')).toEqual({ production: true, manual: false });
    expect(floorToChannels('all')).toEqual({ production: true, manual: true });
    expect(floorToChannels(undefined)).toEqual({ production: false, manual: false });
  });

  it('refuses a policy weaker than the floor', () => {
    expect(isWeakerThanFloor('none', 'production')).toBe(true);
    expect(isWeakerThanFloor(undefined, 'production')).toBe(true);
    expect(isWeakerThanFloor('manual-only', 'production')).toBe(true);
    expect(isWeakerThanFloor('non-manual', 'production')).toBe(false);
    expect(isWeakerThanFloor('all', 'production')).toBe(false);
    expect(isWeakerThanFloor('non-manual', 'all')).toBe(true);
    expect(isWeakerThanFloor('manual-only', 'all')).toBe(true);
    expect(isWeakerThanFloor('all', 'all')).toBe(false);
    for (const p of POLICIES) expect(isWeakerThanFloor(p, 'off')).toBe(false);
    for (const p of POLICIES) expect(isWeakerThanFloor(p, undefined)).toBe(false);
  });

  it('a policy is never weaker than a floor it equals or exceeds channel by channel', () => {
    for (const p of POLICIES) {
      for (const f of FLOORS) {
        const own = policyToChannels(p);
        const min = floorToChannels(f);
        const covers = (!min.production || own.production) && (!min.manual || own.manual);
        expect(isWeakerThanFloor(p, f), `${p} under ${f}`).toBe(!covers);
      }
    }
  });

  it('mergeChannels never lowers a channel', () => {
    const all: RedactionChannels[] = [
      { production: false, manual: false },
      { production: true, manual: false },
      { production: false, manual: true },
      { production: true, manual: true },
    ];
    for (const a of all) {
      expect(mergeChannels(a)).toEqual(a);
      expect(mergeChannels(a, undefined)).not.toBe(a);
      for (const b of all) {
        const m = mergeChannels(a, b);
        expect(m).toEqual({ production: a.production || b.production, manual: a.manual || b.manual });
        expect(mergeChannels(b, a)).toEqual(m);
      }
    }
  });
});

describe('sub-workflow reports in run data', () => {
  const runData: RunData = {
    'Call A': [
      task({ subWorkflowRedaction: { production: true, manual: false }, usedCredentialIds: ['c2', 'c1'] }),
    ],
    'Call B': [
      task(),
      task({ subWorkflowRedaction: { production: false, manual: true }, usedCredentialIds: ['c3', 'c1'] }),
    ],
    Plain: [task({ attempt: 1 })],
  };

  it('reportedChannels is the union of two tasks', () => {
    expect(reportedChannels(runData)).toEqual({ production: true, manual: true });
    expect(reportedChannels({ 'Call A': runData['Call A'] })).toEqual({ production: true, manual: false });
    expect(reportedChannels({})).toEqual({ production: false, manual: false });
    expect(reportedChannels(undefined)).toEqual({ production: false, manual: false });
  });

  it('reportedCredentialIds is the sorted union of two tasks', () => {
    expect(reportedCredentialIds(runData)).toEqual(['c1', 'c2', 'c3']);
    expect(reportedCredentialIds(undefined)).toEqual([]);
  });

  it('ignores malformed metadata from stored JSON', () => {
    const bad = {
      X: [
        task({ subWorkflowRedaction: 'all', usedCredentialIds: 'c9' }),
        task({
          subWorkflowRedaction: { production: 'yes', manual: 1 },
          usedCredentialIds: [7, '', null, 'c4'],
        }),
        null,
      ],
      Y: 'not tasks',
    } as unknown as RunData;
    expect(reportedChannels(bad)).toEqual({ production: false, manual: false });
    expect(reportedCredentialIds(bad)).toEqual(['c4']);
  });

  it('nodeCredentialIds reads every node credential id once', () => {
    const nodes = [
      node('A', { slackApi: { id: 'k2', name: 'Slack' }, httpHeaderAuth: { id: null, name: 'Unsaved' } }),
      node('B', { slackApi: { id: 'k2', name: 'Slack' }, postgres: { id: 'k1', name: 'DB' } }),
      node('C'),
    ];
    expect(nodeCredentialIds(nodes)).toEqual(['k1', 'k2']);
    expect(nodeCredentialIds([])).toEqual([]);
    expect(nodeCredentialIds(undefined)).toEqual([]);
  });

  it('SubWorkflowReport has its final shape', () => {
    const report: SubWorkflowReport = { usedCredentialIds: ['c1'] };
    expectTypeOf(report.usedCredentialIds).toEqualTypeOf<string[]>();
    expectTypeOf<SubWorkflowReport['subWorkflowRedaction']>().toEqualTypeOf<RedactionChannels | undefined>();
  });
});

describe('new type fields', () => {
  it('NodeTypeDescription carries deprecated and replacedBy', () => {
    expectTypeOf<NodeTypeDescription['deprecated']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<NodeTypeDescription['replacedBy']>().toEqualTypeOf<string | undefined>();
  });

  it('WorkflowSettings carries time saved and redaction settings', () => {
    expectTypeOf<WorkflowSettings['timeSavedMode']>().toEqualTypeOf<'fixed' | 'dynamic' | undefined>();
    expectTypeOf<WorkflowSettings['timeSavedPerExecution']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<WorkflowSettings['redactionPolicy']>().toEqualTypeOf<RedactionPolicy | undefined>();
    expectTypeOf<WorkflowSettings['redactCallerExecutions']>().toEqualTypeOf<boolean | undefined>();
    const settings: WorkflowSettings = {
      timeSavedMode: 'fixed',
      timeSavedPerExecution: 5,
      redactionPolicy: 'non-manual',
      redactCallerExecutions: false,
    };
    expect(settings.redactionPolicy).toBe('non-manual');
  });
});
