/**
 * The tools-agent loop, independent of the node so chains and tools can reuse it.
 *
 *   load memory -> model.chat(messages, tools) -> run the requested tools in parallel
 *   (failures go back to the model as tool results) -> repeat until a final answer or
 *   `maxIterations` -> output parser (one automatic retry on parse failure) -> append to memory.
 *
 * Additions beyond common agent runtimes: a token budget that stops runaway loops, per-tool
 * timeouts, a stop-on-tool-error policy, argument validation against the tool schema, usage
 * totals, and secret redaction before anything is persisted to memory.
 */
import {
  type AiChatMessage,
  type AiChatModel,
  type AiChatRequest,
  type AiChatResponse,
  type AiContentPart,
  type AiImagePart,
  type AiOutputParser,
  type AiTool,
  type DataObject,
  type Logger,
  NodeOperationError,
  type WorkflowNode,
} from '@workflow/workflow';
import type { SessionMemory } from '../../shared/ai-inputs';
import { capabilitiesOf } from '../../shared/chat-model';
import { formatSchemaErrors, validateJsonSchema } from '../../shared/json-schema';
import { markToolError } from '../../shared/markers';
import {
  errorMessage,
  messageText,
  raceSignal,
  redactSecrets,
  stringifyResult,
  truncate,
  withTimeout,
} from '../../shared/utils';

export interface AgentStep {
  action: { tool: string; toolInput: DataObject; toolCallId: string; log: string };
  observation: string;
  /** true when the tool failed and the error was returned to the model */
  error?: boolean;
  durationMs: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
}

export interface AgentRunOptions {
  node: WorkflowNode;
  itemIndex: number;
  model: AiChatModel;
  tools: AiTool[];
  memory?: SessionMemory;
  sessionId?: string;
  outputParser?: AiOutputParser;
  systemMessage: string;
  input: string;
  images?: AiImagePart[];
  maxIterations: number;
  /**
   * send answer text through `onChunk`: plain text deltas while the model generates them, or the
   * whole final answer as one chunk when the model cannot stream. The caller owns the wire protocol.
   */
  streaming?: boolean;
  onChunk?: (text: string) => void;
  /** milliseconds per tool call; 0 = no limit */
  toolTimeoutMs?: number;
  toolErrorBehavior?: 'feedback' | 'stop';
  /** stop when input + output tokens exceed this; 0 = unlimited */
  tokenBudget?: number;
  redactMemory?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface AgentResult {
  output: unknown;
  text: string;
  intermediateSteps: AgentStep[];
  usage: AgentUsage;
}

/** observations returned to the model are capped so one tool cannot flood the context */
const MAX_OBSERVATION_CHARS = 100_000;

export async function runAgent(options: AgentRunOptions): Promise<AgentResult> {
  const { node, itemIndex, model, tools, memory, outputParser } = options;
  const fail = (message: string, code: string, description?: string) =>
    new NodeOperationError(node, message, { itemIndex, code, description });

  const sessionId = options.sessionId;
  if (memory && !sessionId) {
    throw fail(
      'No session ID for the memory',
      'AI_NO_SESSION',
      'Map a session ID in the memory node, e.g. {{ $json.sessionId }}.',
    );
  }
  const history = memory ? await memory.load(sessionId!) : [];

  let system = options.systemMessage.trim();
  if (outputParser) system = `${system}\n\n${outputParser.getFormatInstructions()}`.trim();
  const userContent: AiChatMessage['content'] = options.images?.length
    ? ([{ type: 'text', text: options.input }, ...options.images] as AiContentPart[])
    : options.input;
  const messages: AiChatMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...history,
    { role: 'user', content: userContent },
  ];

  const caps = capabilitiesOf(model);
  const wantsSchema = Boolean(outputParser?.schema);
  const nativeSchema = wantsSchema && (tools.length ? caps.structuredOutputWithTools : caps.structuredOutput);
  const responseFormat: AiChatRequest['responseFormat'] = nativeSchema
    ? { type: 'json', schema: outputParser!.schema }
    : undefined;

  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0 };
  const steps: AgentStep[] = [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const streaming = Boolean(options.streaming && model.stream && options.onChunk);

  const callModel = async (request: AiChatRequest): Promise<AiChatResponse> => {
    if (options.signal?.aborted) throw options.signal.reason;
    const response = streaming
      ? await model.stream!(request, (delta) => options.onChunk!(delta))
      : await model.chat(request);
    usage.modelCalls++;
    usage.inputTokens += response.usage?.inputTokens ?? 0;
    usage.outputTokens += response.usage?.outputTokens ?? 0;
    const spent = usage.inputTokens + usage.outputTokens;
    if (options.tokenBudget && spent > options.tokenBudget) {
      throw fail(
        `The agent used ${spent} tokens, more than its budget of ${options.tokenBudget}`,
        'AI_TOKEN_BUDGET',
        'Raise the token budget in the agent options, lower the max iterations, or give the agent fewer, more focused tools.',
      );
    }
    return response;
  };

  const runTool = async (call: NonNullable<AiChatMessage['toolCalls']>[number]): Promise<AiChatMessage> => {
    const started = Date.now();
    const tool = toolsByName.get(call.name);
    let observation: string;
    let failed = false;
    try {
      if (!tool)
        throw new Error(
          `There is no tool named "${call.name}". Available tools: ${[...toolsByName.keys()].join(', ') || 'none'}`,
        );
      const errors = validateJsonSchema(call.arguments ?? {}, tool.parameters);
      if (errors.length)
        throw new Error(`Invalid arguments for "${call.name}": ${formatSchemaErrors(errors)}`);
      const signal = withTimeout(options.signal, options.toolTimeoutMs);
      const result = await raceSignal(tool.invoke(call.arguments ?? {}, { signal }), signal);
      observation = truncate(stringifyResult(result), MAX_OBSERVATION_CHARS);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      failed = true;
      observation = `Error: ${errorMessage(error)}`;
      options.logger?.warn('Agent tool call failed', { tool: call.name, error: errorMessage(error) });
      if (options.toolErrorBehavior === 'stop') {
        throw fail(`Tool "${call.name}" failed: ${errorMessage(error)}`, 'AI_TOOL_ERROR');
      }
    }
    const durationMs = Date.now() - started;
    usage.toolCalls++;
    options.logger?.debug('Agent tool call', { tool: call.name, durationMs, failed });
    steps.push({
      action: {
        tool: call.name,
        toolInput: call.arguments ?? {},
        toolCallId: call.id,
        log: `Invoking "${call.name}" with ${JSON.stringify(call.arguments ?? {})}`,
      },
      observation,
      ...(failed ? { error: true } : {}),
      durationMs,
    });
    const message: AiChatMessage = {
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: observation,
    };
    return failed ? markToolError(message) : message;
  };

  let finalText: string | undefined;
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    const response = await callModel({
      messages,
      tools: tools.length
        ? tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
        : undefined,
      responseFormat,
      signal: options.signal,
    });
    messages.push(response.message);
    const calls = response.message.toolCalls ?? [];
    if (!calls.length) {
      finalText = messageText(response.message.content);
      break;
    }
    const results = await Promise.all(calls.map(runTool));
    messages.push(...results);
  }
  if (finalText === undefined) {
    throw fail(
      `The agent stopped after ${options.maxIterations} iterations without a final answer`,
      'AI_MAX_ITERATIONS',
      'Raise "Max Iterations" in the options, or make the tool descriptions clearer so the agent needs fewer steps.',
    );
  }

  let output: unknown = finalText;
  if (outputParser) {
    try {
      output = await outputParser.parse(finalText);
    } catch (firstError) {
      // one automatic retry: show the model its output and the parse error
      messages.push({
        role: 'user',
        content: `Your previous answer could not be parsed: ${errorMessage(firstError)}\nAnswer again, following these instructions exactly:\n${outputParser.getFormatInstructions()}`,
      });
      const retry = await callModel({
        messages,
        responseFormat:
          responseFormat ??
          (wantsSchema && caps.structuredOutput ? { type: 'json', schema: outputParser.schema } : undefined),
        signal: options.signal,
      });
      messages.push(retry.message);
      finalText = messageText(retry.message.content);
      try {
        output = await outputParser.parse(finalText);
      } catch (secondError) {
        throw fail(`The model output could not be parsed: ${errorMessage(secondError)}`, 'AI_OUTPUT_PARSE');
      }
    }
  }

  // a model that cannot stream still answers a streaming caller, in one chunk
  if (options.streaming && !streaming) options.onChunk?.(finalText);

  // memory is written only after the whole run succeeded (no half-finished exchanges)
  if (memory && sessionId) {
    const clean = (text: string) => (options.redactMemory === false ? text : redactSecrets(text));
    await memory.append(sessionId, [
      { role: 'user', content: clean(options.input) },
      { role: 'assistant', content: clean(finalText) },
    ]);
  }

  return { output, text: finalText, intermediateSteps: steps, usage };
}
