/**
 * P6 S5 (C0): a node's custom telemetry tags (`node.customTelemetryTags`, n8n's `{ tag: [...] }` node setting),
 * resolved after each node run into `task.metadata.tracing`, which the tracing observer adds to the node span.
 * `evaluate(value)` resolves one value as an expression against item 0 of that run.
 *
 * P6-67 (L11): keys are trimmed and a blank key is skipped; each value goes through `evaluate`; only a text, a
 * finite number or a boolean result is kept (a null, undefined, object, array or non-finite result is skipped and
 * reported to `onSkip`); at most `TELEMETRY_TAG_LIMITS.max` tags are read and a text result is cut to
 * `TELEMETRY_TAG_LIMITS.valueLength` characters. An evaluation error skips that one tag. Nothing here throws.
 */
import { TELEMETRY_TAG_LIMITS, telemetryTagsOf, type WorkflowNode } from '@workflow/workflow';

/** undefined when the node has no tags (or none resolved); never throws into the run (the engine also catches) */
export function resolveTelemetryTags(
  node: WorkflowNode,
  evaluate: (value: string) => unknown,
  /** called with the key of each tag that was skipped for its value (the key only, never the value) */
  onSkip?: (key: string) => void,
): Record<string, string | number | boolean> | undefined {
  const tags = telemetryTagsOf(node.customTelemetryTags).slice(0, TELEMETRY_TAG_LIMITS.max);
  if (tags.length === 0) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const { key, value } of tags) {
    let result: unknown;
    try {
      result = evaluate(value);
    } catch {
      skip(onSkip, key);
      continue;
    }
    if (typeof result === 'string') {
      out[key] =
        result.length > TELEMETRY_TAG_LIMITS.valueLength
          ? result.slice(0, TELEMETRY_TAG_LIMITS.valueLength)
          : result;
    } else if (typeof result === 'boolean' || (typeof result === 'number' && Number.isFinite(result))) {
      out[key] = result;
    } else {
      skip(onSkip, key);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function skip(onSkip: ((key: string) => void) | undefined, key: string): void {
  try {
    onSkip?.(key);
  } catch {
    /* a reporting callback must not change the run */
  }
}
