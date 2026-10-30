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

export async function completeWithParser(
  model: AiChatModel,
  messages: AiChatMessage[],
  parser: AiOutputParser | undefined,
  context: { node: WorkflowNode; itemIndex: number; signal?: AbortSignal },
): Promise<CompletionResult> {
  const caps = capabilitiesOf(model);
  const responseFormat =
    parser?.schema && caps.structuredOutput ? ({ type: 'json', schema: parser.schema } as const) : undefined;
  const conversation = [...messages];
  const response = await model.chat({ messages: conversation, responseFormat, signal: context.signal });
  let text = messageText(response.message.content);
  if (!parser) return { text, output: text };
  try {
    return { text, output: await parser.parse(text) };
  } catch (firstError) {
    conversation.push(response.message, {
      role: 'user',
      content: `Your previous answer could not be parsed: ${errorMessage(firstError)}\nAnswer again, following these instructions exactly:\n${parser.getFormatInstructions()}`,
    });
    const retry = await model.chat({ messages: conversation, responseFormat, signal: context.signal });
    text = messageText(retry.message.content);
    try {
      return { text, output: await parser.parse(text) };
    } catch (secondError) {
      throw new NodeOperationError(
        context.node,
        `The model output could not be parsed: ${errorMessage(secondError)}`,
        {
          itemIndex: context.itemIndex,
          code: 'AI_OUTPUT_PARSE',
        },
      );
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
