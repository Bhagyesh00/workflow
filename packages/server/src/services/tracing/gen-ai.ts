/**
 * P6-70 (S5 L14): OpenTelemetry GenAI attributes (`gen_ai.*`) of an AI node run, read from the task data only:
 * the model sub-node's logged model names and `tokenUsage`, and an agent's token sums over its connected model
 * runs. Never a message, prompt, tool argument or output text: only the `model` string and the two token counts
 * are read from the logged input and output, and no other key of either is touched.
 *
 * As n8n: the provider comes from the model node's type; only the agent node (`ai.agent`) is an agent and only chat
 * model runs (`ai.lmChat*`) are calls; an agent span takes the provider and models of its first call, sums the
 * tokens of its chat calls and flags `llm.usage_reported` false when a call reported no usage. Our model sub-node
 * tasks carry no `previousNodeRun` (their source is only `previousNode`), so the calls of one agent run are told
 * apart by the agent run's time span, not by run index as n8n does.
 */
import type { Connections, RunData, TaskData, WorkflowNode } from '@workflow/workflow';

type GenAiAttributes = Record<string, string | number | boolean>;

const MODEL_TYPE_PREFIX = 'ai.lmChat';
const AGENT_TYPE = 'ai.agent';
const USAGE_REPORTED = 'llm.usage_reported';
const MAX_NAME_LENGTH = 200;

/** `gen_ai.provider.name` values, n8n's strings, keyed by the lower-case node type suffix after `ai.lmChat` */
const PROVIDER_NAMES: Record<string, string> = {
  alibabacloud: 'alibaba_cloud',
  anthropic: 'anthropic',
  awsbedrock: 'aws.bedrock',
  azureopenai: 'azure.ai.openai',
  cohere: 'cohere',
  databricks: 'databricks',
  deepseek: 'deepseek',
  googlegemini: 'gcp.gemini',
  googlevertex: 'gcp.vertex_ai',
  groq: 'groq',
  lemonade: 'lemonade',
  minimax: 'minimax',
  mistralcloud: 'mistral',
  moonshot: 'moonshot_ai',
  nvidia: 'nvidia',
  ollama: 'ollama',
  openai: 'openai',
  // our OpenAI-compatible chat node speaks the OpenAI protocol
  openaicompatible: 'openai',
  openrouter: 'openrouter',
  vercelaigateway: 'vercel.ai_gateway',
  xaigrok: 'x_ai',
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

function hasUsage(tokens: { input?: number; output?: number }): boolean {
  return tokens.input !== undefined || tokens.output !== undefined;
}

function modelAttributes(node: WorkflowNode, task: TaskData): GenAiAttributes | undefined {
  const provider = providerOf(node.type);
  if (!provider) return undefined;
  const input = channelJson(task.inputOverride);
  const output = channelJson(task.data);
  const request = modelName(input);
  const response = modelName(output);
  const tokens = tokensOf(output);
  if (!request && !response && !hasUsage(tokens)) return undefined;
  const attributes: GenAiAttributes = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider };
  if (request) attributes['gen_ai.request.model'] = request;
  if (response) attributes['gen_ai.response.model'] = response;
  if (tokens.input !== undefined) attributes['gen_ai.usage.input_tokens'] = tokens.input;
  if (tokens.output !== undefined) attributes['gen_ai.usage.output_tokens'] = tokens.output;
  if (!hasUsage(tokens)) attributes[USAGE_REPORTED] = false;
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
  nodes: readonly WorkflowNode[] | undefined,
): GenAiAttributes {
  const attributes: GenAiAttributes = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': node.name,
    'gen_ai.agent.id': node.id,
  };
  const from = task.startTime;
  const to = task.startTime + Math.max(0, task.executionTime);
  const types = nodes ? new Map(nodes.map((n) => [n.name, n.type])) : undefined;
  const calls: Array<{ type: string | undefined; run: TaskData }> = [];
  for (const name of modelNodesOf(node, connections)) {
    const type = types?.get(name);
    // only chat calls count; with no node list every wired model node is taken for a chat model
    if (types && !type?.startsWith(MODEL_TYPE_PREFIX)) continue;
    for (const run of runData[name] ?? []) {
      // only the runs this agent run made: the sub-node ran for this agent, inside the agent's own time span
      if (run.source?.[0]?.previousNode !== node.name) continue;
      if (run.startTime < from || run.startTime > to) continue;
      calls.push({ type, run });
    }
  }
  if (!calls.length) return attributes;
  // the first call (stable for equal start times) gives the provider and the models
  const ordered = calls
    .map((call, index) => ({ call, index }))
    .sort((a, b) => a.call.run.startTime - b.call.run.startTime || a.index - b.index);
  const first = ordered[0].call;
  const provider = first.type ? providerOf(first.type) : undefined;
  if (provider) attributes['gen_ai.provider.name'] = provider;
  const request = modelName(channelJson(first.run.inputOverride));
  const response = modelName(channelJson(first.run.data));
  if (request) attributes['gen_ai.request.model'] = request;
  if (response) attributes['gen_ai.response.model'] = response;
  let input: number | undefined;
  let output: number | undefined;
  let missing = false;
  for (const { run } of calls) {
    const tokens = tokensOf(channelJson(run.data));
    if (!hasUsage(tokens)) missing = true;
    if (tokens.input !== undefined) input = (input ?? 0) + tokens.input;
    if (tokens.output !== undefined) output = (output ?? 0) + tokens.output;
  }
  if (input !== undefined) attributes['gen_ai.usage.input_tokens'] = input;
  if (output !== undefined) attributes['gen_ai.usage.output_tokens'] = output;
  if (missing) attributes[USAGE_REPORTED] = false;
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
  /** the workflow's nodes: tells the agent's chat model calls from other model sub-nodes (without it all count) */
  nodes?: readonly WorkflowNode[],
): GenAiAttributes | undefined {
  if (node.type === AGENT_TYPE) return agentAttributes(node, taskData, runData, connections, nodes);
  return modelAttributes(node, taskData);
}
