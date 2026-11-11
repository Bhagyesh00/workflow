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
  type ConnectionType,
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
import { checkSingleNode } from '../type-policies/enforce';

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

/** whether a credential of `credentialType` fills a credential slot of the model node `nodeType` */
export function credentialFitsModel(ctx: ServerContext, nodeType: string, credentialType: string): boolean {
  const slots = ctx.registries.nodeTypes.get(nodeType)?.description.credentials ?? [];
  return credentialSlot(ctx, slots, credentialType) !== undefined;
}

/** a chat model setting: the tenant's credential, the chat model node type and the model name */
export interface ModelSetting {
  credentialId: string;
  nodeType: string;
  model: string;
}

/** the sub-nodes of one parent node in a definition, opened as a webhook run opens them */
export interface OpenSubNodes {
  /** what the sub-nodes on input `type` (for example `ai_languageModel`, `ai_tool`) supply, index 0 */
  get(type: ConnectionType): Promise<unknown>;
  /** releases what the sub-nodes opened; the caller runs it in a `finally` */
  close(): Promise<void>;
}

/** P6 S1: where sub-nodes opened outside a workflow run: a project, and the credential ids a server path allows */
export interface SubNodeAccess {
  projectId: string;
  /** ids the server path read itself (a setting's or a connection's credential), never from node data or a body */
  allowCredentials: string[];
}

/**
 * Opens the sub-nodes of `parentName` in `definition` for `tenant` (services mode `internal`), with no
 * hand-built context. The builder's model and the Assistant's model and MCP tools (L9) use it.
 * P6-04: the type policy judges each sub-node's type and its credential types in `access.projectId` before
 * anything is opened (a refusal throws `PolicyViolationError`, its text the caller's answer); the decrypt
 * itself judges the credential's own type too (`CredentialService.provider`).
 */
export async function openSubNodes(
  ctx: ServerContext,
  tenant: TenantRow,
  definition: WorkflowDefinition,
  parentName: string,
  signal: AbortSignal,
  access: SubNodeAccess,
): Promise<OpenSubNodes> {
  const workflow = new Workflow(definition, ctx.registries.nodeTypes);
  const node = workflow.nodes[parentName];
  if (!node) throw new Error(`The definition has no node "${parentName}"`);
  for (const sub of definition.nodes) {
    if (sub.name === parentName) continue;
    await checkSingleNode(ctx.serviceDeps, {
      tenantId: tenant.id,
      projectId: access.projectId,
      nodeType: sub.type,
      credentialTypes: Object.keys(sub.credentials ?? {}),
    });
  }
  const services = await ctx.executions.buildServices({
    tenant,
    executionId: '',
    projectId: access.projectId,
    allowCredentials: access.allowCredentials,
    mode: 'internal',
  });
  const deps: ContextDeps = {
    workflow,
    node,
    services,
    evaluator,
    signal,
  };
  const subNodes = createWebhookSubNodes(deps, { json: {} });
  return {
    get: (type) => subNodes.callbacks.getInputConnectionData(type, 0),
    close: () => subNodes.close(),
  };
}

/**
 * The tenant's builder model. Refusals (L1): no setting `Set an AI model in Settings first`, no AI
 * package `The AI nodes are not installed`, no tool calling or a completion model
 * `This model can't call tools`.
 * P6-36: the model is a workspace setting (set under `instanceAi:manage`) and loads for a turn in any
 * project: `loadModelFromSetting` runs it in the credential's own project with only that credential in
 * `allow`, and the caller's project access is not checked on it. A node credential of the workflow being
 * built never gets there (the context holds credential types only).
 */
export async function loadBuilderModel(
  ctx: ServerContext,
  tenant: TenantRow,
  signal: AbortSignal,
): Promise<BuilderModel> {
  const settings = (tenant.settings ?? {}) as TenantSettings;
  const ai = settings.ai;
  if (!ai?.credentialId || !ai.nodeType || !ai.model) throw new BuilderModelError(NO_MODEL_SET);
  return loadModelFromSetting(ctx, tenant, ai, signal);
}

/**
 * The chat model a setting names (the builder's `TenantSettings.ai`, the Assistant's model), with the
 * same refusals as `loadBuilderModel` and `The AI credential in Settings doesn't fit the chosen model`
 * when the credential fills no credential slot of the node.
 */
export async function loadModelFromSetting(
  ctx: ServerContext,
  tenant: TenantRow,
  setting: ModelSetting,
  signal: AbortSignal,
): Promise<BuilderModel> {
  if (!setting?.credentialId || !setting.nodeType || !setting.model)
    throw new BuilderModelError(NO_MODEL_SET);
  const nodeTypes = ctx.registries.nodeTypes;
  const agentType = nodeTypes.get(AGENT_TYPE);
  const modelType = nodeTypes.get(setting.nodeType);
  if (!agentType || !modelType) throw new BuilderModelError(NO_AI_PACKAGE);
  if (!isBuilderModelNode(nodeTypes, setting.nodeType) || !modelType.supplyData) {
    throw new BuilderModelError(NO_TOOL_CALLING);
  }
  const credential = await ctx.repos.credentials.get(tenant.id, setting.credentialId);
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
        type: setting.nodeType,
        typeVersion: latestVersion(modelType.description),
        position: [0, 200],
        parameters: { ...match.parameters, [modelParameter]: setting.model },
        credentials: { [match.slot.name]: { id: credential.id, name: credential.name } },
      },
    ],
    connections: {
      [MODEL_NODE_NAME]: {
        ai_languageModel: [[{ node: BUILDER_NODE_NAME, type: 'ai_languageModel', index: 0 }]],
      },
    },
  };
  // P6 S1: the setting's credential runs in its own project, and only that credential is allowed
  const subNodes = await openSubNodes(ctx, tenant, definition, BUILDER_NODE_NAME, signal, {
    projectId: credential.projectId,
    allowCredentials: [credential.id],
  });
  let supplied: unknown;
  try {
    supplied = await subNodes.get('ai_languageModel');
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
