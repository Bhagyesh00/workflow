/**
 * Partial run planner (P3-06), as n8n's partial execution: subgraph from the trigger (root) to the destination,
 * dirty nodes and their descendants cleaned, start nodes found (cycle entry, Loop done-output rule, Merge seed).
 * The core engine runs the plan (multi-start).
 *
 * C0 STUB: lane L6 writes the body (and may add fields to PartialRunPlan; L6 is its only consumer).
 */
import type { Item, RunData, WorkflowDefinition } from './interfaces';

export interface PartialRunOptions {
  /** trigger node name to run from; absent = closest parent with run data */
  root?: string;
  /** node name the run stops after */
  destination: string;
  /** run data of the earlier execution */
  runData: RunData;
  pinData?: Record<string, Item[]>;
  /** node names marked dirty since runData was produced */
  dirtyNodeNames?: string[];
}

export interface PartialRunPlan {
  /** node names in the subgraph root .. destination */
  subgraph: string[];
  /** node names the engine starts from (each reads its parents' run data) */
  startNodes: string[];
  /** run data kept for nodes that do not run again */
  runData: RunData;
  pinData: Record<string, Item[]>;
  destination: string;
}

/** throws WorkflowOperationError for "no trigger" and "disabled destination" */
export function planPartialRun(_definition: WorkflowDefinition, _options: PartialRunOptions): PartialRunPlan {
  throw new Error('not implemented (L6)');
}
