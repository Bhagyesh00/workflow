/**
 * P6-70 (S5 L14): OpenTelemetry GenAI attributes (`gen_ai.*`) of an AI node run, read from the task data only:
 * the model sub-node's logged model names and `tokenUsage`, and an agent's token sums over its connected model
 * runs. Never a message, prompt, tool argument or output text: only the `model` string and the two token counts
 * are read from the logged input and output, and no other key of either is touched.
 */
import type { Connections, RunData, TaskData, WorkflowNode } from '@workflow/workflow';

type GenAiAttributes = Record<string, string | number>;

const MODEL_TYPE_PREFIX = 'ai.lmChat';
const AGENT_TYPES = new Set(['ai.agent', 'ai.agentTool']);
const MAX_NAME_LENGTH = 200;

/** `gen_ai.provider.name` well-known values for the model nodes whose vendor name differs from the node suffix */
const PROVIDER_NAMES: Record<string, string> = {
  openai: 'openai',
  openaicompatible: 'openai',
  anthropic: 'anthropic',
  awsbedrock: 'aws.bedrock',
  azureopenai: 'azure.ai.openai',
  cohere: 'cohere',
  googlegemini: 'gcp.gemini',
  googlevertex: 'gcp.vertex_ai',
  mistralcloud: 'mistral_ai',
  ollama: 'ollama',
  deepseek: 'deepseek',
  xaigrok: 'x_ai',
  groq: 'groq',
  openrouter: 'openrouter',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** the provider of a model node type (`ai.lmChatAnthropic` is `anthropic`), or undefined for any other type */
function providerOf(type: string): string | undefined {
  if (!type.startsWith(MODEL_TYPE_PREFIX)) return undefined;
  const suffix = type.slice(MODEL_TYPE_PREFIX.length).toLowerCase();
  if (!suffix) return undefined;
  return PROVIDER_NAMES[suffix] ?? suffix;
}

/** the first json object of the first branch of the sub-node's `ai_languageModel` channel */
function channelJson(
  connections: TaskData['data'] | TaskData['inputOverride'],
): Record<string, unknown> | undefined {
  const json: unknown = connections?.ai_languageModel?.[0]?.[0]?.json;
  return isRecord(json) ? json : undefined;
}

function modelName(json: Record<string, unknown> | undefined): string | undefined {
  const model = json?.model;
  if (typeof model !== 'string' || !model.trim()) return undefined;
  return model.slice(0, MAX_NAME_LENGTH);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function tokensOf(output: Record<string, unknown> | undefined): { input?: number; output?: number } {
  const usage = output?.tokenUsage;
  if (!isRecord(usage)) return {};
  return { input: count(usage.inputTokens), output: count(usage.outputTokens) };
}

function modelAttributes(node: WorkflowNode, task: TaskData): GenAiAttributes | undefined {
  const provider = providerOf(node.type);
  if (!provider) return undefined;
  const input = channelJson(task.inputOverride);
  const output = channelJson(task.data);
  const request = modelName(input);
  const response = modelName(output);
  const tokens = tokensOf(output);
  if (!request && !response && tokens.input === undefined && tokens.output === undefined) return undefined;
  const attributes: GenAiAttributes = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider };
  if (request) attributes['gen_ai.request.model'] = request;
  if (response) attributes['gen_ai.response.model'] = response;
  if (tokens.input !== undefined) attributes['gen_ai.usage.input_tokens'] = tokens.input;
  if (tokens.output !== undefined) attributes['gen_ai.usage.output_tokens'] = tokens.output;
  return attributes;
}

/** the model nodes wired into the agent's `ai_languageModel` input */
function modelNodesOf(agent: WorkflowNode, connections: Connections): string[] {
  const names: string[] = [];
  for (const [source, outputs] of Object.entries(connections)) {
    const branches = outputs.ai_languageModel ?? [];
    const wired = branches.some((branch) => branch?.some((c) => c.node === agent.name));
    if (wired) names.push(source);
  }
  return names;
}

function agentAttributes(
  node: WorkflowNode,
  task: TaskData,
  runData: RunData,
  connections: Connections,
): GenAiAttributes {
  const attributes: GenAiAttributes = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': node.name,
    'gen_ai.agent.id': node.id,
  };
  const from = task.startTime;
  const to = task.startTime + Math.max(0, task.executionTime);
  let input: number | undefined;
  let output: number | undefined;
  for (const name of modelNodesOf(node, connections)) {
    for (const run of runData[name] ?? []) {
      // only the runs this agent run made: the sub-node ran for this agent, inside the agent's own time span
      if (run.source?.[0]?.previousNode !== node.name) continue;
      if (run.startTime < from || run.startTime > to) continue;
      const tokens = tokensOf(channelJson(run.data));
      if (tokens.input !== undefined) input = (input ?? 0) + tokens.input;
      if (tokens.output !== undefined) output = (output ?? 0) + tokens.output;
    }
  }
  if (input !== undefined) attributes['gen_ai.usage.input_tokens'] = input;
  if (output !== undefined) attributes['gen_ai.usage.output_tokens'] = output;
  return attributes;
}

/**
 * The `gen_ai.*` attributes of one node run, or undefined for a node with none (not an AI node, or a model node
 * whose run logged no model data).
 */
export function genAiAttributes(
  node: WorkflowNode,
  taskData: TaskData,
  runData: RunData,
  connections: Connections,
): GenAiAttributes | undefined {
  if (AGENT_TYPES.has(node.type)) return agentAttributes(node, taskData, runData, connections);
  return modelAttributes(node, taskData);
}
