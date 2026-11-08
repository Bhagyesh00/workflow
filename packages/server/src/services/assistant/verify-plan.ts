/**
 * Which nodes of a draft `verify_workflow` runs and which it pins with a fixture (P5-70, lane L7). It
 * fails closed: only data-only nodes of `VERIFY_RUN_ALLOW_LIST` run, and only when they hold no
 * credential and no parameter at any depth names `$vars`, `$secrets`, `$credentials`, `$env` or uses
 * `this`; every other node, every trigger and every credentialed node is simulated. C0 stub with the
 * final signature.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { WorkflowDefinition } from '@workflow/workflow';

/** the node types verify may run for real (data only, no outside call) */
export const VERIFY_RUN_ALLOW_LIST: readonly string[] = [
  'core.manualTrigger',
  'core.noOp',
  'core.set',
  'core.if',
  'core.switch',
  'core.filter',
  'core.merge',
  'core.sort',
  'core.limit',
  'core.removeDuplicates',
  'core.aggregate',
  'core.splitOut',
  'core.summarize',
  'core.renameKeys',
  'core.compareDatasets',
  'core.splitInBatches',
  'core.dateTime',
];

/** node names to run (`execute`) and to pin with a fixture (`simulate`); every node is in exactly one */
export function planVerify(
  _definition: WorkflowDefinition,
  _nodeTypes: NodeTypeRegistry,
): { execute: string[]; simulate: string[] } {
  throw new Error('not implemented (L7)');
}
