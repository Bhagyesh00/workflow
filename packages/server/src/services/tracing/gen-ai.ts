/**
 * P6-70 (S5 C0 stub, L14 fills it): OpenTelemetry GenAI attributes (`gen_ai.*`) of an AI node run: model, provider,
 * token counts; never a message, prompt or output text.
 */
import type { Connections, RunData, TaskData, WorkflowNode } from '@workflow/workflow';

/** stub (L14): PASSES: no attributes */
export function genAiAttributes(
  _node: WorkflowNode,
  _taskData: TaskData,
  _runData: RunData,
  _connections: Connections,
): Record<string, string | number> | undefined {
  return undefined;
}
