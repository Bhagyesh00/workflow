/**
 * P6-67 (S5 L11): the custom span attributes: project tags as `project.custom.<key>`, workflow tags
 * (`settings.customTelemetryTags`) as `workflow.custom.<key>`, node tags (`taskData.metadata.tracing`) as
 * `node.custom.<key>`; `gen_ai` keys are left out of node tags, as n8n. Keys are trimmed, a blank key is skipped,
 * at most `TELEMETRY_TAG_LIMITS.max` tags per source are used and a value is cut to `TELEMETRY_TAG_LIMITS.valueLength`.
 * Every value is text. The tracing observer leaves `node` out for a redacted run, so no node tag reaches such a span.
 */
import { TELEMETRY_TAG_LIMITS, type TelemetryTag } from '@workflow/workflow';

const NODE_EXCLUDED_PREFIX = 'gen_ai';

const bound = (text: string): string =>
  text.length > TELEMETRY_TAG_LIMITS.valueLength ? text.slice(0, TELEMETRY_TAG_LIMITS.valueLength) : text;

function fromTags(prefix: string, tags: TelemetryTag[] | undefined, out: Record<string, string>): void {
  if (!Array.isArray(tags)) return;
  let used = 0;
  for (const tag of tags) {
    if (used >= TELEMETRY_TAG_LIMITS.max) break;
    if (!tag || typeof tag.key !== 'string') continue;
    const key = tag.key.trim();
    if (key === '') continue;
    out[`${prefix}${key}`] = bound(typeof tag.value === 'string' ? tag.value : '');
    used += 1;
  }
}

function fromNode(tracing: Record<string, unknown> | undefined, out: Record<string, string>): void {
  if (!tracing || typeof tracing !== 'object') return;
  let used = 0;
  for (const [rawKey, value] of Object.entries(tracing)) {
    if (used >= TELEMETRY_TAG_LIMITS.max) break;
    const key = rawKey.trim();
    if (key === '' || key === NODE_EXCLUDED_PREFIX || key.startsWith(`${NODE_EXCLUDED_PREFIX}.`)) continue;
    if (typeof value === 'string') out[`node.custom.${key}`] = bound(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      out[`node.custom.${key}`] = String(value);
    else continue;
    used += 1;
  }
}

/** the attributes to add to a span; empty when nothing is tagged */
export function customAttributes(input: {
  project?: { tags: TelemetryTag[] };
  workflow?: { tags: TelemetryTag[] };
  node?: { tracing?: Record<string, unknown> };
}): Record<string, string> {
  const out: Record<string, string> = {};
  fromTags('project.custom.', input.project?.tags, out);
  fromTags('workflow.custom.', input.workflow?.tags, out);
  fromNode(input.node?.tracing, out);
  return out;
}
