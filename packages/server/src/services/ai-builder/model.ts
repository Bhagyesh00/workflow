/**
 * The builder's chat model (P5-09). `loadBuilderModel` is L1's: it reads `TenantSettings.ai`, builds a
 * one-parent definition (an `ai.agent` parent named `Builder` and the chat node with `{ model }` and the
 * credential ref) and gets the model through `createWebhookSubNodes`, so no context is hand built.
 * `isBuilderModelNode` is FULL from C0 and stays as is.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { AiChatModel } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';

export interface BuilderModel {
  model: AiChatModel;
  /** releases what the sub-node opened; the caller runs it in a `finally` */
  close(): Promise<void>;
}

/**
 * The tenant's builder model. Refusals (L1): no setting `Set an AI model in Settings first`, no AI
 * package `The AI nodes are not installed`, no tool calling or a completion model
 * `This model can't call tools`.
 */
export async function loadBuilderModel(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _signal: AbortSignal,
): Promise<BuilderModel> {
  throw new Error('not implemented (L1)');
}

const MODEL_PREFIX = 'ai.lmChat';
const MODEL_OUTPUT = 'ai_languageModel';

/**
 * True when `type` can be the builder's model: its name starts with `ai.lmChat`, the type exists in
 * `nodeTypes`, and its outputs hold `ai_languageModel` (string or `{ type }` port form). A type whose
 * outputs are an expression is refused.
 */
export function isBuilderModelNode(nodeTypes: NodeTypeRegistry, type: string): boolean {
  if (typeof type !== 'string' || !type.startsWith(MODEL_PREFIX)) return false;
  const nodeType = nodeTypes.get(type);
  if (!nodeType) return false;
  const outputs = nodeType.description?.outputs;
  if (!Array.isArray(outputs)) return false;
  return outputs.some((port) =>
    typeof port === 'string' ? port === MODEL_OUTPUT : port?.type === MODEL_OUTPUT,
  );
}
