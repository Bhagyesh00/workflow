import {
  type DataObject,
  type ExecuteContext,
  highlightedResponseKey,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import {
  COMPLETION_MODEL_NODES,
  getChatModel,
  getFallbackModel,
  getMemory,
  getOutputParser,
  getPrompt,
  getTools,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
import { batchingOption, runInBatches } from '../../shared/batching';
import { errorMessage } from '../../shared/utils';
import { runAgent } from './agent-loop';
import { binaryParts } from './passthrough';

const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful assistant';

const modelPort = (displayName: string) => ({
  type: 'ai_languageModel',
  displayName,
  required: true,
  maxConnections: 1,
  filter: { excludedNodes: COMPLETION_MODEL_NODES },
});

/**
 * v1 has no `hasOutputParser` (the property is hidden, so the expression sees undefined) and keeps the
 * parser port; v2 shows the property, default off, and the port follows it. The fallback model is the
 * second chat-model port and exists only while `needsFallback` is on.
 */
const AGENT_INPUTS = `={{ ['main', ${JSON.stringify(modelPort('Chat Model'))}, ...($parameter.needsFallback === true ? [${JSON.stringify(modelPort('Fallback Model'))}] : []), { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }, { type: 'ai_tool', displayName: 'Tool' }, ...($parameter.hasOutputParser !== false ? [{ type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 }] : [])] }}`;

/** The agent's own parameters, shared with the AI Agent Tool node. */
export const agentProperties: NodeProperty[] = [
  promptTypeProperty,
  promptTextProperty,
  {
    displayName: 'Require Specific Output Format',
    name: 'hasOutputParser',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description: 'Whether to connect an output parser to structure the answer',
    displayOptions: { show: { '@version': [{ _cnd: { gte: 2 } }] } },
  },
  {
    displayName: 'Enable Fallback Model',
    name: 'needsFallback',
    type: 'boolean',
    default: false,
    noDataExpression: true,
    description: 'Whether a second chat model answers the turn when the first one fails',
  },
  {
    displayName: 'System Message',
    name: 'systemMessage',
    type: 'string',
    default: DEFAULT_SYSTEM_MESSAGE,
    typeOptions: { rows: 4 },
    description: 'Instructions that shape how the agent behaves',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    options: [
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
        typeOptions: { minValue: 1, maxValue: 100 },
        description: 'Model calls allowed before the agent gives up',
      },
      {
        displayName: 'Return Intermediate Steps',
        name: 'returnIntermediateSteps',
        type: 'boolean',
        default: false,
        description: 'Whether to include the tool calls and their results in the output',
      },
      {
        displayName: 'Automatically Passthrough Binary Images',
        name: 'passthroughBinaryImages',
        type: 'boolean',
        default: true,
        description: 'Whether images in the input item are sent to the model with the prompt',
      },
      {
        displayName: 'Automatically Passthrough Binary PDFs',
        name: 'passthroughBinaryPdfs',
        type: 'boolean',
        default: false,
        description:
          'Whether PDFs and text files in the input item are sent to the model with the prompt (PDFs as files, text files as text)',
      },
      {
        displayName: 'Force Tool Call on First Iteration',
        name: 'forceToolCallOnFirstIteration',
        type: 'boolean',
        default: false,
        description:
          'Whether the first model call must call one of the tools. Needs a model that supports it.',
      },
      batchingOption(1),
      {
        displayName: 'Tracing Metadata',
        name: 'tracingMetadata',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true },
        placeholder: 'Add metadata',
        description: "Key and value pairs stored with this node's run data. Nothing is sent elsewhere.",
        options: [
          {
            displayName: 'Metadata',
            name: 'values',
            values: [
              { displayName: 'Key', name: 'key', type: 'string', default: '' },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'string',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                ],
              },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        displayName: 'Save Output for Execution Filters',
        name: 'autoSaveHighlightedData',
        type: 'boolean',
        default: true,
        description:
          'Whether a text answer is saved on the execution, so the Execution Data node and the executions list can use it',
      },
      {
        displayName: 'Enable Streaming',
        name: 'enableStreaming',
        type: 'boolean',
        default: true,
        description: 'Whether to stream the answer to a Chat Trigger in streaming response mode',
      },
      {
        displayName: 'Token Budget',
        name: 'tokenBudget',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Stop the run when input + output tokens exceed this number (0 = no limit)',
      },
      {
        displayName: 'Tool Timeout (ms)',
        name: 'toolTimeout',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0 },
        description: 'Fail a tool call that takes longer than this (0 = no limit); the model sees the error',
      },
      {
        displayName: 'On Tool Error',
        name: 'toolErrorBehavior',
        type: 'options',
        default: 'feedback',
        options: [
          {
            name: 'Tell the Model',
            value: 'feedback',
            description: 'Return the error as the tool result so the model can recover',
          },
          { name: 'Stop the Agent', value: 'stop', description: 'Fail the item' },
        ],
      },
      {
        displayName: 'Return Token Usage',
        name: 'returnUsage',
        type: 'boolean',
        default: false,
        description: 'Whether to include token and call counts in the output',
      },
      {
        displayName: 'Redact Secrets in Memory',
        name: 'redactMemory',
        type: 'boolean',
        default: true,
        description:
          'Whether API keys, tokens and private keys are removed before the exchange is saved to memory',
      },
    ],
  },
];

const STREAMING_HINT =
  "Streaming is on for this agent, but the Chat Trigger does not use the Streaming response mode, so the answer is sent in one piece. Set the trigger's Response Mode to Streaming to stream it.";

/** true when a Chat Trigger upstream answers in another mode than streaming */
function chatTriggerNotStreaming(ctx: ExecuteContext): boolean {
  try {
    for (const parent of ctx.getParentNodes()) {
      if (parent.type !== 'ai.chatTrigger') continue;
      const mode = ctx.evaluateExpression(
        `={{ $node[${JSON.stringify(parent.name)}].parameter.options?.responseMode }}`,
        0,
      );
      if (mode !== 'streaming') return true;
    }
  } catch {
    // an unreadable trigger gives no hint
  }
  return false;
}

function tracingMetadata(options: DataObject): DataObject {
  const rows = (options.tracingMetadata as { values?: Array<Record<string, unknown>> } | undefined)?.values;
  const out: DataObject = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = typeof row.key === 'string' ? row.key.trim() : '';
    if (!key || key === '__proto__') continue;
    const raw = row.value;
    out[key] =
      row.type === 'number'
        ? Number(raw)
        : row.type === 'boolean'
          ? raw === true || String(raw).toLowerCase() === 'true'
          : String(raw ?? '');
  }
  return out;
}

/** an item that did not run because an earlier one failed */
class SkippedItem extends Error {}

export async function executeAgent(ctx: ExecuteContext): Promise<Item[][]> {
  const items = ctx.getInputData();
  const options0 = (ctx.getNodeParameter('options', 0, {}) ?? {}) as DataObject;
  const batching = (options0.batching ?? {}) as DataObject;
  const traced = tracingMetadata(options0);
  if (Object.keys(traced).length) ctx.setMetadata({ tracing: traced });
  if (options0.enableStreaming !== false && chatTriggerNotStreaming(ctx)) {
    ctx.addExecutionHints({ message: STREAMING_HINT, level: 'info' });
  }

  const processItem = async (i: number): Promise<Item> => {
    try {
      const options = (ctx.getNodeParameter('options', i, {}) ?? {}) as DataObject;
      const input = getPrompt(ctx, i, items[i], { emptyText: 'No prompt specified' });
      const model = await getChatModel(ctx, i, { chatOnly: true });
      let fallbackModel: Awaited<ReturnType<typeof getFallbackModel>> | undefined;
      if (ctx.getNodeParameter('needsFallback', i, false) === true) {
        fallbackModel = await getFallbackModel(ctx, i);
        if (fallbackModel.completion) {
          throw new NodeOperationError(
            ctx.getNode(),
            `${fallbackModel.nodeName ?? 'The fallback model'} is a text completion model; connect a chat model`,
            { itemIndex: i },
          );
        }
      }
      const memory = await getMemory(ctx, i);
      const tools = await getTools(ctx, i);
      const outputParser =
        ctx.getNodeParameter('hasOutputParser', i, true) === false
          ? undefined
          : await getOutputParser(ctx, i);
      const sessionId = memory
        ? (memory.sessionId ??
          (typeof items[i].json.sessionId === 'string' ? items[i].json.sessionId : undefined))
        : undefined;
      const result = await runAgent({
        node: ctx.getNode(),
        itemIndex: i,
        model,
        fallbackModel,
        tools,
        memory,
        sessionId: sessionId as string | undefined,
        outputParser,
        systemMessage: String(ctx.getNodeParameter('systemMessage', i, DEFAULT_SYSTEM_MESSAGE) ?? ''),
        input,
        attachments: await binaryParts(ctx, i, items[i], {
          images: options.passthroughBinaryImages !== false,
          files: options.passthroughBinaryPdfs === true,
        }),
        forceToolCallOnFirstIteration: options.forceToolCallOnFirstIteration === true,
        maxIterations: Number(options.maxIterations ?? 10),
        streaming: options.enableStreaming !== false,
        onChunk: (chunk) => ctx.sendChunk(chunk),
        toolTimeoutMs: Number(options.toolTimeout ?? 0),
        toolErrorBehavior: (options.toolErrorBehavior as 'feedback' | 'stop') ?? 'feedback',
        tokenBudget: Number(options.tokenBudget ?? 0),
        redactMemory: options.redactMemory !== false,
        signal: ctx.signal,
        logger: ctx.logger,
      });
      const json: DataObject = { output: result.output as DataObject[string] };
      if (options.returnIntermediateSteps)
        json.intermediateSteps = result.intermediateSteps as unknown as DataObject[];
      if (options.returnUsage) json.usage = { ...result.usage };
      // the first output only, and only a text answer (a parser's object is not text)
      if (options.autoSaveHighlightedData !== false && i === 0 && typeof result.output === 'string') {
        ctx.setCustomData(highlightedResponseKey(ctx.getNode().name), result.output);
      }
      return { json, pairedItem: { item: i } };
    } catch (error) {
      if (ctx.continueOnFail()) {
        return {
          json: { error: errorMessage(error) },
          error: { message: errorMessage(error) },
          pairedItem: { item: i },
        };
      }
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex: i, cause: error });
    }
  };

  // a failed item stops the ones after it, as the one-by-one loop did (with batches, the items of the
  // same batch have started already)
  let stopped = false;
  const results = await runInBatches(
    items.length,
    {
      batchSize: Number(batching.batchSize ?? 1),
      delayMs: Number(batching.delayBetweenBatches ?? 0),
      signal: ctx.signal instanceof AbortSignal ? ctx.signal : undefined,
    },
    async (i) => {
      if (stopped) throw new SkippedItem();
      try {
        return await processItem(i);
      } catch (error) {
        stopped = true;
        throw error;
      }
    },
  );
  const out: Item[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') out.push(result.value);
    else if (!(result.reason instanceof SkippedItem)) throw result.reason;
  }
  return [out];
}

export const AgentNode: NodeType = {
  description: {
    name: 'ai.agent',
    displayName: 'AI Agent',
    description:
      'Answers with a chat model that can call tools, remember the conversation and return structured output',
    icon: 'lucide:bot',
    group: ['transform'],
    version: [1, 2],
    defaults: { name: 'AI Agent' },
    inputs: AGENT_INPUTS,
    outputs: ['main'],
    categories: ['AI', 'Agents'],
    alias: ['llm', 'assistant', 'tools agent', 'function calling', 'chatbot'],
    properties: agentProperties,
  },

  execute: executeAgent,
};
