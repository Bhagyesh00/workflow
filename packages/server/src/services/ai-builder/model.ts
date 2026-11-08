/**
 * The builder's chat model (P5-09). `loadBuilderModel` is L1's: it reads `TenantSettings.ai`, builds a
 * one-parent definition (an `ai.agent` parent named `Builder` and the chat node with `{ model }` and the
 * credential ref) and gets the model through `createWebhookSubNodes`, so no context is hand built.
 * `isBuilderModelNode` is FULL from C0 and stays as is.
 */
import { randomUUID } from 'node:crypto';
import { type ContextDeps, createWebhookSubNodes, type NodeTypeRegistry } from '@workflow/core';
import {
  type AiChatModel,
  ExpressionEvaluator,
  latestVersion,
  type NodeCredentialDescription,
  type NodeParameters,
  Workflow,
  type WorkflowDefinition,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { TenantSettings } from '../../plans';

export interface BuilderModel {
  model: AiChatModel;
  /** releases what the sub-node opened; the caller runs it in a `finally` */
  close(): Promise<void>;
}

/** a refusal the user can act on; its message goes to the client as is */
export class BuilderModelError extends Error {
  override name = 'BuilderModelError';
}

export const NO_MODEL_SET = 'Set an AI model in Settings first';
export const NO_AI_PACKAGE = 'The AI nodes are not installed';
export const NO_TOOL_CALLING = "This model can't call tools";
export const CREDENTIAL_MISMATCH = "The AI credential in Settings doesn't fit the chosen model";

/** the parent of the model sub-node; the builder's agent loop runs under this name */
export const BUILDER_NODE_NAME = 'Builder';
const AGENT_TYPE = 'ai.agent';
const MODEL_NODE_NAME = 'Model';
/** the model parameter of a chat node: `model` on most, `modelName` on Gemini and Vertex */
const MODEL_PARAMETERS = ['model', 'modelName'];

const evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });

/** the credential slot of `nodeType` that `credentialType` fills, and the parameters that show it */
function credentialSlot(
  ctx: ServerContext,
  slots: NodeCredentialDescription[],
  credentialType: string,
): { slot: NodeCredentialDescription; parameters: NodeParameters } | undefined {
  const types = ctx.registries.credentialTypes;
  const slot =
    slots.find((s) => s.name === credentialType) ?? slots.find((s) => types.isA(credentialType, s.name));
  if (!slot) return undefined;
  // a slot shown by a parameter value (for example `authentication`) gets that value
  const parameters: NodeParameters = {};
  for (const [name, values] of Object.entries(slot.displayOptions?.show ?? {})) {
    if (name.startsWith('@') || name.startsWith('/')) continue;
    if (Array.isArray(values) && values.length && typeof values[0] !== 'object') parameters[name] = values[0];
  }
  return { slot, parameters };
}

/**
 * The tenant's builder model. Refusals (L1): no setting `Set an AI model in Settings first`, no AI
 * package `The AI nodes are not installed`, no tool calling or a completion model
 * `This model can't call tools`.
 */
export async function loadBuilderModel(
  ctx: ServerContext,
  tenant: TenantRow,
  signal: AbortSignal,
): Promise<BuilderModel> {
  const settings = (tenant.settings ?? {}) as TenantSettings;
  const ai = settings.ai;
  if (!ai?.credentialId || !ai.nodeType || !ai.model) throw new BuilderModelError(NO_MODEL_SET);
  const nodeTypes = ctx.registries.nodeTypes;
  const agentType = nodeTypes.get(AGENT_TYPE);
  const modelType = nodeTypes.get(ai.nodeType);
  if (!agentType || !modelType) throw new BuilderModelError(NO_AI_PACKAGE);
  if (!isBuilderModelNode(nodeTypes, ai.nodeType) || !modelType.supplyData) {
    throw new BuilderModelError(NO_TOOL_CALLING);
  }
  const credential = await ctx.repos.credentials.get(tenant.id, ai.credentialId);
  if (!credential) throw new BuilderModelError(NO_MODEL_SET);
  const match = credentialSlot(ctx, modelType.description.credentials ?? [], credential.type);
  if (!match) throw new BuilderModelError(CREDENTIAL_MISMATCH);

  const modelParameter =
    MODEL_PARAMETERS.find((name) => modelType.description.properties.some((p) => p.name === name)) ?? 'model';
  const definition: WorkflowDefinition = {
    name: 'AI builder',
    nodes: [
      {
        id: randomUUID(),
        name: BUILDER_NODE_NAME,
        type: AGENT_TYPE,
        typeVersion: latestVersion(agentType.description),
        position: [0, 0],
        parameters: {},
      },
      {
        id: randomUUID(),
        name: MODEL_NODE_NAME,
        type: ai.nodeType,
        typeVersion: latestVersion(modelType.description),
        position: [0, 200],
        parameters: { ...match.parameters, [modelParameter]: ai.model },
        credentials: { [match.slot.name]: { id: credential.id, name: credential.name } },
      },
    ],
    connections: {
      [MODEL_NODE_NAME]: {
        ai_languageModel: [[{ node: BUILDER_NODE_NAME, type: 'ai_languageModel', index: 0 }]],
      },
    },
  };
  const workflow = new Workflow(definition, nodeTypes);
  const services = await ctx.executions.buildServices({ tenant, executionId: '', mode: 'internal' });
  const deps: ContextDeps = {
    workflow,
    node: workflow.nodes[BUILDER_NODE_NAME],
    services,
    evaluator,
    signal,
  };
  const subNodes = createWebhookSubNodes(deps, { json: {} });
  let supplied: unknown;
  try {
    supplied = await subNodes.callbacks.getInputConnectionData('ai_languageModel', 0);
  } catch (error) {
    await subNodes.close();
    throw error;
  }
  const model = (Array.isArray(supplied) ? supplied[0] : supplied) as AiChatModel | undefined;
  if (model?.kind !== 'chatModel' || typeof model.chat !== 'function' || model.completion) {
    await subNodes.close();
    throw new BuilderModelError(NO_TOOL_CALLING);
  }
  return { model, close: () => subNodes.close() };
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
