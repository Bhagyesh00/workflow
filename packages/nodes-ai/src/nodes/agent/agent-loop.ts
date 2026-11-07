/**
 * The tools-agent loop, independent of the node so chains and tools can reuse it.
 *
 *   load memory -> model.chat(messages, tools) -> run the requested tools in parallel
 *   (failures go back to the model as tool results) -> repeat until a final answer or
 *   `maxIterations` -> output parser (one automatic retry on parse failure) -> append to memory.
 *
 * A tool can stop the run to wait (`ToolSuspension`). The other calls of the turn finish, further waiting calls
 * stay queued, and the loop throws `AgentSuspended` with its state. The next run starts from that state with the
 * answer the engine got: it never loads memory again and writes it only at the very end.
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
  type AiOutputParser,
  type AiTool,
  type DataObject,
  type Item,
  isToolSuspension,
  type Logger,
  NodeOperationError,
  type ToolSuspension,
  type WorkflowNode,
} from '@workflow/workflow';
import type { SessionMemory } from '../../shared/ai-inputs';
import { capabilitiesOf } from '../../shared/chat-model';
import { formatSchemaErrors, validateJsonSchema } from '../../shared/json-schema';
import { hasRestoredRawContent, markToolError } from '../../shared/markers';
import { PARSE_ERROR, PARSE_ERROR_HELP } from '../../shared/structured';
import {
  errorMessage,
  messageText,
  raceSignal,
  redactSecrets,
  stringifyResult,
  truncate,
  withTimeout,
} from '../../shared/utils';
import {
  type AgentLoopState,
  AgentSuspended,
  restoreMessages,
  storableMessages,
  storableRawContent,
} from './checkpoint';

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
  /** images, PDFs and text files that go to the model after the prompt text */
  attachments?: AiContentPart[];
  /** answers the turn when `model` fails, while no text has gone out; same tools and messages */
  fallbackModel?: AiChatModel;
  /** the first model call of the run must call a tool */
  forceToolCallOnFirstIteration?: boolean;
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
  /** continue a run that stopped for a tool, with the answer the tool got */
  resume?: { state: AgentLoopState; answer: Item[][] | null };
}

export interface AgentResult {
  output: unknown;
  text: string;
  intermediateSteps: AgentStep[];
  usage: AgentUsage;
}

/** observations returned to the model are capped so one tool cannot flood the context */
const MAX_OBSERVATION_CHARS = 100_000;

const WAIT_ENDED = 'The tool finished waiting without a response.';

type ToolCall = NonNullable<AiChatMessage['toolCalls']>[number];

/** a human review gate's tool: only this loop's resume path reaches it, never what a model sends */
type ReviewGate = AiTool & {
  answerReview?(
    args: DataObject,
    answer: Item[][] | null,
    options: { signal?: AbortSignal; toolCallId: string },
  ): Promise<unknown>;
};

/** what the model reads from a plain tool's wait: the JSON of its first output */
const waitResult = (answer: Item[][] | null): string =>
  answer ? JSON.stringify((answer[0] ?? []).map((item) => item.json)) : WAIT_ENDED;

export async function runAgent(options: AgentRunOptions): Promise<AgentResult> {
  const { node, itemIndex, model, tools, memory, outputParser, resume } = options;
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
  const history = memory && !resume ? await memory.load(sessionId!) : [];

  let system = options.systemMessage.trim();
  if (outputParser) system = `${system}\n\n${outputParser.getFormatInstructions()}`.trim();
  const userContent: AiChatMessage['content'] = options.attachments?.length
    ? ([{ type: 'text', text: options.input }, ...options.attachments] as AiContentPart[])
    : options.input;
  const messages: AiChatMessage[] = resume
    ? restoreMessages(resume.state, options.attachments)
    : [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        ...history,
        { role: 'user', content: userContent },
      ];
  const promptIndex = resume ? resume.state.promptIndex : messages.length - 1;

  const wantsSchema = Boolean(outputParser?.schema);
  /** the native response format, when this model can combine it with the agent's tools */
  const responseFormatFor = (m: AiChatModel): AiChatRequest['responseFormat'] => {
    const caps = capabilitiesOf(m);
    const native = wantsSchema && (tools.length ? caps.structuredOutputWithTools : caps.structuredOutput);
    return native ? { type: 'json', schema: outputParser!.schema } : undefined;
  };

  const usage: AgentUsage = resume
    ? { ...resume.state.usage }
    : { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0 };
  const steps: AgentStep[] = resume ? [...(resume.state.steps as AgentStep[])] : [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const wantsStream = Boolean(options.streaming && options.onChunk);
  let streamed = resume?.state.streamed ?? false;

  const invoke = (m: AiChatModel, request: AiChatRequest): Promise<AiChatResponse> => {
    if (wantsStream && m.stream) {
      return m.stream(request, (delta) => {
        if (delta) streamed = true;
        options.onChunk!(delta);
      });
    }
    return m.chat(request);
  };

  const madeByFallback = new WeakSet<AiChatMessage>();
  for (const { message, fallback } of resume?.state.rawContent ?? []) {
    if (fallback && messages[message]) madeByFallback.add(messages[message]);
  }
  /** as before a wait, raw content goes back only to the model that made it: the other gets a copy without it */
  const forModel = (list: AiChatMessage[], fallback: boolean): AiChatMessage[] =>
    list.map((m) => (hasRestoredRawContent(m) && madeByFallback.has(m) !== fallback ? { ...m } : m));

  const callModel = async (request: AiChatRequest): Promise<AiChatResponse> => {
    if (options.signal?.aborted) throw options.signal.reason;
    let response: AiChatResponse;
    try {
      response = await invoke(model, {
        ...request,
        messages: forModel(request.messages, false),
        responseFormat: responseFormatFor(model),
      });
    } catch (error) {
      // a cancelled run is not a model failure, and a stream cannot be taken back
      if (!options.fallbackModel || options.signal?.aborted || streamed) throw error;
      options.logger?.warn('Agent model call failed, using the fallback model');
      response = await invoke(options.fallbackModel, {
        ...request,
        messages: forModel(request.messages, true),
        responseFormat: responseFormatFor(options.fallbackModel),
      });
      madeByFallback.add(response.message);
    }
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

  const noSuchTool = (name: string) =>
    new Error(
      `There is no tool named "${name}". Available tools: ${[...toolsByName.keys()].join(', ') || 'none'}`,
    );

  /** one call, with its timeout, its step and its message; a failure goes back to the model as the result */
  const runCall = async (
    call: ToolCall,
    work: (signal: AbortSignal | undefined) => Promise<unknown>,
  ): Promise<AiChatMessage> => {
    const started = Date.now();
    let observation: string;
    let failed = false;
    try {
      const signal = withTimeout(options.signal, options.toolTimeoutMs);
      const result = await raceSignal(work(signal), signal);
      // a tool with an error output returns its error text as a result, so this path redacts too
      observation = truncate(redactSecrets(stringifyResult(result)), MAX_OBSERVATION_CHARS);
    } catch (error) {
      if (isToolSuspension(error)) throw error;
      if (options.signal?.aborted) throw options.signal.reason;
      failed = true;
      observation = `Error: ${redactSecrets(errorMessage(error))}`;
      options.logger?.warn('Agent tool call failed', { tool: call.name });
      if (options.toolErrorBehavior === 'stop') {
        throw fail(`Tool "${call.name}" failed: ${redactSecrets(errorMessage(error))}`, 'AI_TOOL_ERROR');
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

  const runTool = (call: ToolCall): Promise<AiChatMessage> =>
    runCall(call, async (signal) => {
      const tool = toolsByName.get(call.name);
      if (!tool) throw noSuchTool(call.name);
      const errors = validateJsonSchema(call.arguments ?? {}, tool.parameters);
      if (errors.length)
        throw new Error(`Invalid arguments for "${call.name}": ${formatSchemaErrors(errors)}`);
      return tool.invoke(call.arguments ?? {}, { signal, toolCallId: call.id });
    });

  /** the loop's state for the checkpoint: the turn has `results` so far, `call` waits, `pending` have not started */
  const suspendedAt = (
    suspension: ToolSuspension,
    call: ToolCall,
    results: AiChatMessage[],
    pending: ToolCall[],
  ): AgentSuspended => {
    const rawContent = storableRawContent(messages, madeByFallback);
    return new AgentSuspended(suspension, {
      messages: storableMessages(messages, promptIndex),
      promptIndex,
      steps,
      usage,
      iterations,
      parseRetried,
      streamed,
      results,
      waiting: { call, ...(suspension.gatedTool ? { gatedTool: suspension.gatedTool } : {}) },
      pending,
      ...(rawContent.length ? { rawContent } : {}),
    });
  };

  /**
   * The calls of a turn, after the results it already has. Tools that cannot wait run in parallel; tools that can
   * run one at a time, because a call that waits stops the rest: only one message goes out for a person to answer.
   */
  const runTurn = async (calls: ToolCall[], earlier: AiChatMessage[]): Promise<AiChatMessage[]> => {
    const results = [...earlier];
    const pending: ToolCall[] = [];
    const stop: { waiting?: { suspension: ToolSuspension; call: ToolCall } } = {};
    const attempt = async (call: ToolCall) => {
      if (stop.waiting) {
        pending.push(call);
        return;
      }
      try {
        results.push(await runTool(call));
      } catch (error) {
        if (!isToolSuspension(error)) throw error;
        if (stop.waiting) pending.push(call);
        else stop.waiting = { suspension: error, call };
      }
    };
    const canWait = (call: ToolCall) => toolsByName.get(call.name)?.canWait === true;
    const inTurn = async () => {
      for (const call of calls.filter(canWait)) await attempt(call);
    };
    await Promise.all([...calls.filter((call) => !canWait(call)).map(attempt), inTurn()]);
    if (stop.waiting) throw suspendedAt(stop.waiting.suspension, stop.waiting.call, results, pending);
    return results;
  };

  /** the results in the order the model asked for them */
  const inCallOrder = (results: AiChatMessage[]): AiChatMessage[] => {
    const calls = messages.at(-1)?.toolCalls ?? [];
    const position = (result: AiChatMessage) => calls.findIndex((call) => call.id === result.toolCallId);
    return [...results].sort((a, b) => position(a) - position(b));
  };

  /** what the wait of `waiting` gave the model; a gated call asks its gate, which reads the answer */
  const answerWait = (waiting: AgentLoopState['waiting'], answer: Item[][] | null) => {
    const { call, gatedTool } = waiting;
    return runCall(call, async (signal) => {
      if (!gatedTool) return waitResult(answer);
      const gate = toolsByName.get(call.name) as ReviewGate | undefined;
      if (!gate?.answerReview) throw noSuchTool(call.name);
      return gate.answerReview(gatedTool.arguments, answer, { signal, toolCallId: call.id });
    });
  };

  /** the turn the run stopped in: the answer of the waiting call, then the calls that had to wait for it */
  const finishTurn = async ({ state, answer }: NonNullable<AgentRunOptions['resume']>) => {
    let answered: AiChatMessage;
    try {
      answered = await answerWait(state.waiting, answer);
    } catch (error) {
      if (!isToolSuspension(error)) throw error;
      throw suspendedAt(error, state.waiting.call, state.results, state.pending);
    }
    return inCallOrder(await runTurn(state.pending, [...state.results, answered]));
  };

  const modelTools = tools.length
    ? tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
    : undefined;
  // the output-parser retry gets its own iteration budget
  let iterations = resume?.state.iterations ?? 0;
  let parseRetried = resume?.state.parseRetried ?? false;
  let forceTool = Boolean(options.forceToolCallOnFirstIteration && modelTools && !resume);
  let resuming = resume;
  const answer = async (): Promise<string> => {
    if (resuming) {
      const turn = resuming;
      resuming = undefined;
      messages.push(...(await finishTurn(turn)));
    }
    while (iterations < options.maxIterations) {
      iterations++;
      const response = await callModel({
        messages,
        tools: modelTools,
        ...(forceTool ? { toolChoice: 'any' as const } : {}),
        signal: options.signal,
      });
      forceTool = false;
      messages.push(response.message);
      const calls = response.message.toolCalls ?? [];
      if (!calls.length) return messageText(response.message.content);
      messages.push(...inCallOrder(await runTurn(calls, [])));
    }
    throw fail(
      `Max iterations (${options.maxIterations}) reached. The agent could not complete the task within the allowed number of iterations.`,
      'AI_MAX_ITERATIONS',
      'Raise "Max Iterations" in the options, or make the tool descriptions clearer so the agent needs fewer steps.',
    );
  };

  let finalText = await answer();

  let output: unknown = finalText;
  if (outputParser) {
    try {
      output = await outputParser.parse(finalText);
    } catch (firstError) {
      if (parseRetried) {
        throw fail(`${PARSE_ERROR}: ${errorMessage(firstError)}`, 'AI_OUTPUT_PARSE', PARSE_ERROR_HELP);
      }
      parseRetried = true;
      // one automatic retry: show the model its output and the parse error
      messages.push({
        role: 'user',
        content: `Your previous answer could not be parsed: ${errorMessage(firstError)}\nAnswer again, following these instructions exactly:\n${outputParser.getFormatInstructions()}`,
      });
      // same tools and format as the first pass: the history holds tool calls the provider needs them for
      iterations = 0;
      finalText = await answer();
      try {
        output = await outputParser.parse(finalText);
      } catch (secondError) {
        throw fail(`${PARSE_ERROR}: ${errorMessage(secondError)}`, 'AI_OUTPUT_PARSE', PARSE_ERROR_HELP);
      }
    }
  }

  // a model that cannot stream still answers a streaming caller, in one chunk
  if (wantsStream && !streamed) options.onChunk?.(finalText);

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
