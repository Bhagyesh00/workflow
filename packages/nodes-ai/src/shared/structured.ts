/** One model call with an optional output parser: native JSON schema when the model supports it, one retry on parse failure. */
import {
  type AiChatMessage,
  type AiChatModel,
  type AiOutputParser,
  NodeOperationError,
  type WorkflowNode,
} from '@workflow/workflow';
import { capabilitiesOf } from './chat-model';
import { errorMessage, messageText } from './utils';

export interface CompletionResult {
  text: string;
  output: unknown;
}

function responseFormatFor(model: AiChatModel, parser: AiOutputParser | undefined) {
  return parser?.schema && capabilitiesOf(model).structuredOutput
    ? ({ type: 'json', schema: parser.schema } as const)
    : undefined;
}

/** One call to `model`; when it fails (not by an abort) and a fallback model is set, the same request goes there. */
async function chatWithFallback(
  model: AiChatModel,
  fallback: AiChatModel | undefined,
  conversation: AiChatMessage[],
  parser: AiOutputParser | undefined,
  signal: AbortSignal | undefined,
) {
  const attempt = (m: AiChatModel) =>
    m.chat({ messages: [...conversation], responseFormat: responseFormatFor(m, parser), signal });
  try {
    return await attempt(model);
  } catch (error) {
    if (!fallback || signal?.aborted) throw error;
    return attempt(fallback);
  }
}

/**
 * `fallback` answers when the main model fails. `autoFix: false` (default true) skips the corrective
 * retry, so an unparsable answer fails at once.
 */
export async function completeWithParser(
  model: AiChatModel,
  messages: AiChatMessage[],
  parser: AiOutputParser | undefined,
  context: {
    node: WorkflowNode;
    itemIndex: number;
    signal?: AbortSignal;
    fallback?: AiChatModel;
    autoFix?: boolean;
  },
): Promise<CompletionResult> {
  const conversation = [...messages];
  const response = await chatWithFallback(model, context.fallback, conversation, parser, context.signal);
  let text = messageText(response.message.content);
  if (!parser) return { text, output: text };
  const failure = (error: unknown) =>
    new NodeOperationError(context.node, `The model output could not be parsed: ${errorMessage(error)}`, {
      itemIndex: context.itemIndex,
      code: 'AI_OUTPUT_PARSE',
    });
  try {
    return { text, output: await parser.parse(text) };
  } catch (firstError) {
    if (context.autoFix === false) throw failure(firstError);
    conversation.push(response.message, {
      role: 'user',
      content: `Your previous answer could not be parsed: ${errorMessage(firstError)}
Answer again, following these instructions exactly:
${parser.getFormatInstructions()}`,
    });
    const retry = await chatWithFallback(model, context.fallback, conversation, parser, context.signal);
    text = messageText(retry.message.content);
    try {
      return { text, output: await parser.parse(text) };
    } catch (secondError) {
      throw failure(secondError);
    }
  }
}

/** Append format instructions to the system message (or add one). */
export function withFormatInstructions(messages: AiChatMessage[], parser?: AiOutputParser): AiChatMessage[] {
  if (!parser) return messages;
  const instructions = parser.getFormatInstructions();
  const index = messages.findIndex((m) => m.role === 'system');
  if (index < 0) return [{ role: 'system', content: instructions }, ...messages];
  return messages.map((m, i) =>
    i === index ? { ...m, content: `${messageText(m.content)}\n\n${instructions}` } : m,
  );
}
