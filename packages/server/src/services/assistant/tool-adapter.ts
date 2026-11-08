/**
 * Assistant tool definitions as `AiTool`s for `runAgent` (P5-67, lane L1). Per call: re-read the
 * caller's role, `input.parse`, `approvals.gate`, then `handler`; the result goes through
 * `shapeToolResult` (redact, cap, wrap), is saved as a tool message and emitted, then `def.artifact`.
 * Parameters are `z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' })`. A definition whose
 * `available(run)` is false is dropped. C0 stub with the final signatures.
 */
import type { AiTool } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { AssistantApprovals } from './approvals';
import type { AssistantRunScope, AssistantToolDefinition } from './types';

export function toAiTools(
  _ctx: ServerContext,
  _defs: AssistantToolDefinition[],
  _run: AssistantRunScope,
  _approvals: AssistantApprovals,
): AiTool[] {
  throw new Error('not implemented (L1)');
}

/**
 * What the model sees of a tool result, the same for a live result and an approved one: through
 * `redactSecrets`, capped at `ASSISTANT_RESULT_CHARS`, wrapped by `wrapUntrusted(def.untrusted, ...)`
 * when the definition names a source.
 */
export function shapeToolResult(_def: AssistantToolDefinition, _result: unknown): string {
  throw new Error('not implemented (L1)');
}
