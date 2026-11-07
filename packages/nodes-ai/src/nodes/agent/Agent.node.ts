import { type DataObject, type Item, NodeOperationError, type NodeType } from '@workflow/workflow';
import {
  binaryImages,
  getChatModel,
  getMemory,
  getOutputParser,
  getPrompt,
  getTools,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
import { errorMessage } from '../../shared/utils';
import { runAgent } from './agent-loop';

const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful assistant.';

export const AgentNode: NodeType = {
  description: {
    name: 'ai.agent',
    displayName: 'AI Agent',
    description:
      'Answers with a chat model that can call tools, remember the conversation and return structured output',
    icon: 'lucide:bot',
    group: ['transform'],
    version: 1,
    defaults: { name: 'AI Agent' },
    inputs: [
      'main',
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
      { type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 },
    ],
    outputs: ['main'],
    categories: ['AI', 'Agents'],
    alias: ['llm', 'assistant', 'tools agent', 'function calling', 'chatbot'],
    properties: [
      promptTypeProperty,
      promptTextProperty,
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
            description:
              'Fail a tool call that takes longer than this (0 = no limit); the model sees the error',
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
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const input = getPrompt(ctx, i, items[i]);
        const model = await getChatModel(ctx, i, { chatOnly: true });
        const memory = await getMemory(ctx, i);
        const tools = await getTools(ctx, i);
        const outputParser = await getOutputParser(ctx, i);
        const sessionId = memory
          ? (memory.sessionId ??
            (typeof items[i].json.sessionId === 'string' ? items[i].json.sessionId : undefined))
          : undefined;
        const result = await runAgent({
          node: ctx.getNode(),
          itemIndex: i,
          model,
          tools,
          memory,
          sessionId: sessionId as string | undefined,
          outputParser,
          systemMessage: String(ctx.getNodeParameter('systemMessage', i, DEFAULT_SYSTEM_MESSAGE) ?? ''),
          input,
          images: options.passthroughBinaryImages === false ? [] : await binaryImages(ctx, i, items[i]),
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
        out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (ctx.continueOnFail()) {
          out.push({
            json: { error: errorMessage(error) },
            error: { message: errorMessage(error) },
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex: i, cause: error });
      }
    }
    return [out];
  },
};
