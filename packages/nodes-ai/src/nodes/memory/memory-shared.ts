/**
 * Parts every chat memory node shares: the description shell, the window parameter, the stored
 * message shape and the wrapper that logs memory calls for the editor's AI logs.
 */
import type {
  AiChatMessage,
  DataObject,
  NodeProperty,
  NodeTypeDescription,
  SupplyDataContext,
} from '@workflow/workflow';
import { logAiEvent } from '../../shared/ai-events';
import type { SessionMemory } from '../../shared/ai-inputs';
import { messageText, truncate } from '../../shared/utils';

/** a single stored message is capped so one huge answer cannot bloat every later prompt */
const MAX_STORED_CHARS = 50_000;

export const windowProperty: NodeProperty = {
  displayName: 'Context Window Length',
  name: 'contextWindowLength',
  type: 'number',
  default: 5,
  typeOptions: { minValue: 1, maxValue: 200 },
  description: 'How many past exchanges (user message + answer) the model sees',
};

/** The description of a memory sub-node: no inputs, one `ai_memory` output, category Memory. */
export function memoryDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'credentials'>,
  properties: NodeProperty[],
): NodeTypeDescription {
  return {
    ...base,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: [],
    outputs: ['ai_memory'],
    outputNames: ['Memory'],
    categories: ['AI', 'Memory'],
    alias: ['chat history', 'conversation', 'remember'],
    properties,
  };
}

/** `contextWindowLength` of this item, 1 to 200, 5 when unset or invalid */
export function windowSize(ctx: SupplyDataContext, itemIndex: number): number {
  return Math.max(1, Math.min(200, Number(ctx.getNodeParameter('contextWindowLength', itemIndex, 5)) || 5));
}

/**
 * Only role, text and the hide flag are stored: images and provider internals never reach memory.
 * `hideFromUI` is written only when true, so stored rows of earlier versions keep their shape.
 */
export function toStoredMessage(message: AiChatMessage): {
  role: string;
  content: string;
  hideFromUI?: true;
} {
  const stored: { role: string; content: string; hideFromUI?: true } = {
    role: message.role,
    content: truncate(messageText(message.content), MAX_STORED_CHARS),
  };
  if (message.hideFromUI === true) stored.hideFromUI = true;
  return stored;
}

export function fromStoredMessage(value: unknown): AiChatMessage | undefined {
  const v = (typeof value === 'string' ? safeParse(value) : value) as DataObject | undefined;
  if (!v || (v.role !== 'user' && v.role !== 'assistant' && v.role !== 'system')) return undefined;
  const message: AiChatMessage = { role: v.role, content: typeof v.content === 'string' ? v.content : '' };
  if (v.hideFromUI === true) message.hideFromUI = true;
  return message;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Wraps a store so `load` and `append` show in the editor's AI logs; the other calls pass through. */
export function logged(ctx: SupplyDataContext, memory: SessionMemory): SessionMemory {
  return {
    kind: 'memory',
    sessionId: memory.sessionId,
    async load(sessionId) {
      const messages = await memory.load(sessionId);
      ctx.logSubNodeRun(
        { action: 'loadMemoryVariables', sessionId },
        { chatHistory: messages.map(toStoredMessage) },
      );
      logAiEvent(ctx, 'ai.memory.get.messages', { sessionId, messages: messages.map(toStoredMessage) });
      return messages;
    },
    loadAll: (sessionId) => memory.loadAll(sessionId),
    async append(sessionId, messages) {
      await memory.append(sessionId, messages);
      ctx.logSubNodeRun({ action: 'saveContext', sessionId }, { chatHistory: messages.map(toStoredMessage) });
      logAiEvent(ctx, 'ai.memory.added.message', { sessionId, messages: messages.map(toStoredMessage) });
    },
    replace: (sessionId, messages) => memory.replace(sessionId, messages),
    clear: (sessionId) => memory.clear(sessionId),
  };
}
