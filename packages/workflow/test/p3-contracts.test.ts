import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type CompactionVersion,
  type DirtyReason,
  dirtyNodesFromDiff,
  type ExtractionResult,
  expandSelectionWithSubNodes,
  extractSubWorkflow,
  GROUP_DESCRIPTION_MAX_LENGTH,
  type GroupingProblem,
  type GroupingProblemCode,
  NODE_GROUPING_RULES,
  normalizeGroupDescription,
  type PartialRunPlan,
  planPartialRun,
  selectRedundantVersions,
  validateSelectionForExtraction,
  validateSelectionForGrouping,
  validateWorkflowNodeGroups,
  type WorkflowDefinition,
  type WorkflowNodeGroup,
} from '../src';

describe('Phase 3 contracts (C0)', () => {
  it('WorkflowDefinition carries nodeGroups and versionId', () => {
    const group: WorkflowNodeGroup = { id: 'g1', name: 'Group', nodeIds: ['a'], description: 'd' };
    const def: WorkflowDefinition = {
      name: 'wf',
      nodes: [],
      connections: {},
      nodeGroups: [group],
      versionId: 'v1',
    };
    expectTypeOf(def.nodeGroups).toEqualTypeOf<WorkflowNodeGroup[] | undefined>();
    expectTypeOf(def.versionId).toEqualTypeOf<string | undefined>();
  });

  it('node-grouping exports the rule constants and functions', () => {
    expect(GROUP_DESCRIPTION_MAX_LENGTH).toBe(145);
    expect(NODE_GROUPING_RULES).toEqual({
      allowTriggers: false,
      maxEntryNodes: 1,
      maxExitNodes: 1,
      allowNonMainBoundary: false,
      maxGroupsPerNode: 1,
    });
    expect(Object.isFrozen(NODE_GROUPING_RULES)).toBe(true);
    for (const fn of [
      validateSelectionForGrouping,
      validateSelectionForExtraction,
      validateWorkflowNodeGroups,
      expandSelectionWithSubNodes,
      normalizeGroupDescription,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expectTypeOf(validateSelectionForGrouping).returns.toEqualTypeOf<GroupingProblem[]>();
    expectTypeOf(validateWorkflowNodeGroups).returns.toEqualTypeOf<GroupingProblem[]>();
    expectTypeOf<'trigger' | 'disconnected' | 'deprecated'>().toMatchTypeOf<GroupingProblemCode>();
  });

  it('extraction, partial run, dirty nodes and compaction exports', () => {
    for (const fn of [extractSubWorkflow, planPartialRun, dirtyNodesFromDiff, selectRedundantVersions]) {
      expect(typeof fn).toBe('function');
    }
    expectTypeOf(extractSubWorkflow).returns.toEqualTypeOf<ExtractionResult>();
    expectTypeOf(planPartialRun).returns.toEqualTypeOf<PartialRunPlan>();
    expectTypeOf(dirtyNodesFromDiff).returns.toEqualTypeOf<Record<string, DirtyReason>>();
    expectTypeOf<DirtyReason>().toEqualTypeOf<'parameters' | 'connections' | 'pinned' | 'upstream'>();
    expectTypeOf<CompactionVersion['versionName']>().toEqualTypeOf<string | null>();
    expectTypeOf<CompactionVersion['description']>().toEqualTypeOf<string | null>();
    expectTypeOf(selectRedundantVersions).returns.toEqualTypeOf<string[]>();
  });
});
