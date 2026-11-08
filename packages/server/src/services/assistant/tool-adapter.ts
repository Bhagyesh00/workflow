/**
 * Assistant tool definitions as `AiTool`s for `runAgent` (P5-67, lane L1). Per call: re-read the
 * caller's role (a user demoted during the turn is refused at the call, not only at the list),
 * `input.parse`, `approvals.gate`, then `handler`; the result goes through `shapeToolResult` (redact, cap,
 * wrap), is saved as a tool message and emitted, then `def.artifact`. Parameters are
 * `z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' })`. A definition whose `available(run)`
 * is false is dropped, so a forged call to it gets `runAgent`'s unknown-tool answer.
 *
 * A failed call stores `Error: <text>` as its result (the same text `runAgent` gives the model) and
 * emits `tool-error`; a handler's own error text goes through `shapeToolError` (redact, cap, wrap) like a
 * result, the adapter's refusals stay plain. A gated call stores the gate's placeholder until L3 replaces it.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiTool,
  ASSISTANT_RESULT_CHARS,
  type DataObject,
  type JsonSchema,
  redactSecrets,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { wrapUntrusted } from '../ai-builder/context';
import { hasRole } from '../auth';
import type { AssistantApprovals } from './approvals';
import { redactDeep } from './events';
import type { AssistantRunScope, AssistantToolDefinition } from './types';

/** the part of the approvals a call uses (the run wraps it to see a card it wrote) */
export type ToolGate = Pick<AssistantApprovals, 'gate'>;

/** what the model reads when the caller lost the role a tool needs during the turn */
export const ASSISTANT_TOOL_NO_ACCESS = 'You no longer have access to this tool';

/** the tool's arguments as JSON Schema (an object schema, as providers require) */
export function toolParameters(def: AssistantToolDefinition): JsonSchema {
  const schema = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  if (schema.type !== 'object') return { type: 'object', properties: {} };
  return schema as JsonSchema;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text || 'The tool failed');
}

/**
 * What the model sees of a handler's error: its text shaped like a result (`shapeToolResult`), since a
 * thrown message can carry outside text (an MCP server's error, a remote error body).
 */
export function shapeToolError(def: AssistantToolDefinition, error: unknown): string {
  return shapeToolResult(def, errorText(error));
}

/** zod issues as one short line the model can act on */
function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length ? issue.path.map(String).join('.') : 'arguments'}: ${issue.message}`)
    .join('; ');
}

/** saves the tool message answering `toolCallId` once (a second save of the same call is skipped) */
async function saveResult(
  ctx: ServerContext,
  run: AssistantRunScope,
  toolCallId: string,
  name: string,
  content: string,
): Promise<boolean> {
  const repo = ctx.repos.assistantThreads;
  const answered = await repo.answeredToolCallIds(run.tenant.id, run.threadId, [toolCallId]);
  if (answered.has(toolCallId)) return false;
  await repo.appendMessage(run.tenant.id, run.threadId, {
    runId: run.runId,
    role: 'tool',
    content,
    toolCallId,
    name,
  });
  return true;
}

class ToolCallError extends Error {
  override name = 'AssistantToolError';
}

async function invokeTool(
  ctx: ServerContext,
  def: AssistantToolDefinition,
  run: AssistantRunScope,
  approvals: ToolGate,
  args: DataObject,
  toolCallId: string,
): Promise<string> {
  const fail = async (text: string): Promise<never> => {
    const content = `Error: ${text}`;
    if (!run.signal.aborted && (await saveResult(ctx, run, toolCallId, def.name, content))) {
      run.emit({
        type: 'tool-error',
        runId: run.runId,
        payload: { toolCallId, toolName: def.name, error: text },
      });
    }
    throw new ToolCallError(text);
  };

  // the role now, not the one the turn started with
  const membership = await ctx.repos.memberships.get(run.tenant.id, run.user.id);
  if (!membership || !hasRole(membership.role, def.minRole)) return fail(ASSISTANT_TOOL_NO_ACCESS);

  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) return fail(`Invalid arguments for "${def.name}": ${issuesText(parsed.error)}`);
  const input = parsed.data;

  let result: unknown;
  try {
    const gate = await approvals.gate(run, def, input, toolCallId);
    if (gate.decision === 'refuse') return fail(redactSecrets(gate.reason));
    if (gate.decision === 'suspended') {
      // the card waits; the model reads the placeholder until the person answers (L3 replaces it)
      await saveResult(ctx, run, toolCallId, def.name, gate.placeholder);
      return gate.placeholder;
    }
    result = await def.handler(ctx, run, input);
  } catch (error) {
    if (error instanceof ToolCallError) throw error;
    if (run.signal.aborted) throw error;
    return fail(shapeToolError(def, error));
  }
  if (run.signal.aborted) throw run.signal.reason ?? new Error('The run was stopped');

  const shaped = shapeToolResult(def, result);
  if (await saveResult(ctx, run, toolCallId, def.name, shaped)) {
    run.emit({
      type: 'tool-result',
      runId: run.runId,
      payload: { toolCallId, toolName: def.name, result: shaped },
    });
    const artifact = def.artifact?.(input, result);
    if (artifact)
      run.emit({ type: 'artifact', runId: run.runId, payload: { artifact: redactDeep(artifact) } });
  }
  return shaped;
}

export function toAiTools(
  ctx: ServerContext,
  defs: AssistantToolDefinition[],
  run: AssistantRunScope,
  approvals: ToolGate,
): AiTool[] {
  const seen = new Set<string>();
  const tools: AiTool[] = [];
  for (const def of defs) {
    if (def.available && !def.available(run)) continue;
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    tools.push({
      kind: 'tool',
      name: def.name,
      description: def.description,
      parameters: toolParameters(def),
      invoke: (args, options) =>
        invokeTool(ctx, def, run, approvals, args, options?.toolCallId ?? randomUUID()),
    });
  }
  return tools;
}

/**
 * What the model sees of a tool result, the same for a live result and an approved one: through
 * `redactSecrets`, capped at `ASSISTANT_RESULT_CHARS`, wrapped by `wrapUntrusted(def.untrusted, ...)`
 * when the definition names a source.
 */
export function shapeToolResult(def: AssistantToolDefinition, result: unknown): string {
  let text: string;
  if (typeof result === 'string') text = result;
  else if (result === undefined) text = '';
  else {
    try {
      text = JSON.stringify(result) ?? '';
    } catch {
      text = String(result);
    }
  }
  text = redactSecrets(text);
  if (text.length > ASSISTANT_RESULT_CHARS) {
    text = `${text.slice(0, ASSISTANT_RESULT_CHARS)}\n[The result was cut at ${ASSISTANT_RESULT_CHARS} characters]`;
  }
  return def.untrusted ? wrapUntrusted(def.untrusted, text) : text;
}
