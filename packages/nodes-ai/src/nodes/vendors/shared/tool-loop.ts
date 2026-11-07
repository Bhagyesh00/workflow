/**
 * The tool loop of vendor message operations: a chat model over the node's own `ExecuteContext` (an
 * `HttpChatModel` on a `ChatAdapter`, or the caller's model) run through `runAgent` with the connected
 * tools.
 */
import {
  type AiChatMessage,
  type AiChatModel,
  type AiContentPart,
  type ExecuteContext,
  NodeOperationError,
} from '@workflow/workflow';
import { getTools, type SessionMemory } from '../../../shared/ai-inputs';
import { type ChatAdapter, HttpChatModel } from '../../../shared/chat-model';
import { messageText } from '../../../shared/utils';
import { type AgentStep, type AgentUsage, runAgent } from '../../agent/agent-loop';

/** the error code of the refusal for a tool that waits; `eachVendorItem` never turns it into an item */
export const VENDOR_WAIT_TOOL = 'VENDOR_WAIT_TOOL';

/**
 * A node `inputs` expression: `main`, plus `{ type: 'ai_tool', displayName: 'Tools' }` while `condition`
 * (an expression body over `$parameter`) holds.
 */
export function vendorToolsInput(condition: string): string {
  const port = JSON.stringify({ type: 'ai_tool', displayName: 'Tools' });
  return `={{ ['main', ...((${condition}) ? [${port}] : [])] }}`;
}

/** a history that lives for one call: the earlier messages of the node's Messages */
function callMemory(history: AiChatMessage[], sessionId: string): SessionMemory {
  const stored = [...history];
  return {
    kind: 'memory',
    sessionId,
    load: async () => [...stored],
    loadAll: async () => [...stored],
    append: async (_id, messages) => {
      stored.push(...messages);
    },
    replace: async (_id, messages) => {
      stored.splice(0, stored.length, ...messages);
    },
    clear: async () => {
      stored.length = 0;
    },
  };
}

/**
 * Send `messages` (and `system`) to the model, run the connected tools up to `maxIterations` model calls,
 * and return the final text, the vendor's raw last reply (undefined when `model` is given), usage and
 * steps. Refuses before the first call when a connected tool can wait. With `useTools: false` the
 * connected tools are not read at all: the engine still supplies a saved connection after the Tools input
 * is hidden, so a caller whose Tools input is hidden (Hide Tools, or an operation with no Tools input)
 * passes false. The default is true.
 */
export async function runVendorChat(
  ctx: ExecuteContext,
  itemIndex: number,
  adapter: ChatAdapter,
  options: {
    messages: AiChatMessage[];
    system?: string;
    maxIterations: number;
    model?: AiChatModel;
    useTools?: boolean;
  },
): Promise<{ text: string; raw: unknown; usage: AgentUsage; steps: AgentStep[] }> {
  const node = ctx.getNode();
  const tools = options.useTools === false ? [] : await getTools(ctx, itemIndex);
  const waiting = tools.find((tool) => tool.canWait === true);
  if (waiting) {
    // a vendor node has no checkpoint to stop at: refuse before anything is sent
    throw new NodeOperationError(
      node,
      `Nodes that wait for an answer cannot be used as tools of "${node.name}". Move "${waiting.name}" to an Agent node.`,
      { itemIndex, code: VENDOR_WAIT_TOOL },
    );
  }

  const last = options.messages.length - 1;
  const prompt = options.messages[last];
  if (!prompt || prompt.role !== 'user') {
    throw new NodeOperationError(node, 'The last message must be a user message', {
      itemIndex,
      description: 'Add a message with the role "user" at the end of the Messages.',
    });
  }
  const parts: AiContentPart[] = typeof prompt.content === 'string' ? [] : prompt.content;
  // text files arrive as text parts: they join the prompt, one paragraph each
  const input = parts.length
    ? parts
        .filter((part): part is Extract<AiContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n')
    : messageText(prompt.content);
  const attachments = parts.filter((part) => part.type !== 'text');
  const history = options.messages.slice(0, last);

  let raw: unknown;
  let model = options.model;
  if (!model) {
    // the vendor's last reply is kept by looking at what the adapter parses
    const wrapped = Object.create(adapter, {
      parseResponse: {
        value: (body: unknown) => {
          raw = body;
          return adapter.parseResponse(body);
        },
      },
    }) as ChatAdapter;
    model = new HttpChatModel(ctx, wrapped, { itemIndex, maxRetries: 2 });
  }

  const sessionId = `vendor-${itemIndex}`;
  const result = await runAgent({
    node,
    itemIndex,
    model,
    tools,
    memory: history.length ? callMemory(history, sessionId) : undefined,
    sessionId: history.length ? sessionId : undefined,
    systemMessage: options.system ?? '',
    input,
    attachments: attachments.length ? attachments : undefined,
    // a run with the loop capped at 0 would never call the model
    maxIterations: Math.max(1, options.maxIterations),
    signal: ctx.signal,
    logger: ctx.logger,
    redactMemory: false,
  });
  return { text: result.text, raw, usage: result.usage, steps: result.intermediateSteps };
}
