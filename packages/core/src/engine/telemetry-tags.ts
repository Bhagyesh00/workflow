/**
 * P6 S5 (C0): a node's custom telemetry tags (`node.customTelemetryTags`, n8n's `{ tag: [...] }` node setting),
 * resolved after each node run into `task.metadata.tracing`, which the tracing observer adds to the node span.
 * `evaluate(value)` resolves one value as an expression against item 0 of that run.
 */
import type { WorkflowNode } from '@workflow/workflow';

/** undefined when the node has no tags; never throws into the run (the engine also catches) */
export function resolveTelemetryTags(
  node: WorkflowNode,
  evaluate: (value: string) => unknown,
): Record<string, string | number | boolean> | undefined {
  // stub (L11): PASSES, so no task gains `tracing` until L11 resolves the node's tags
  void node;
  void evaluate;
  return undefined;
}
