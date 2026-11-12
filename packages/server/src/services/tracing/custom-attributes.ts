/**
 * P6-67 (S5 C0 stub, L11 fills it): the custom span attributes: project tags as `project.custom.<key>`, workflow
 * tags (`settings.customTelemetryTags`) as `workflow.custom.<key>`, node tags (`taskData.metadata.tracing`) as
 * `node.custom.<key>`; `gen_ai` keys are left out of node tags, as n8n.
 */
import type { TelemetryTag } from '@workflow/workflow';

/** stub (L11): PASSES: no attributes */
export function customAttributes(_input: {
  project?: { tags: TelemetryTag[] };
  workflow?: { tags: TelemetryTag[] };
  node?: { tracing?: Record<string, unknown> };
}): Record<string, string> {
  return {};
}
