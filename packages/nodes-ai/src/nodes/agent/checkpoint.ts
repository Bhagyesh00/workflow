/**
 * What an agent keeps while its run waits for a tool. It is stored with the execution as JSON, so it holds what
 * the agent has said and done and nothing it can read again: no image or file data (the resumed run reads those
 * from the item's binary) and no credential (the resumed run gets its sub-nodes from the engine again). It does hold
 * the provider's raw content of the agent's turns: a new adapter has no other way to replay thinking blocks.
 */
import {
  type AiChatMessage,
  type AiContentPart,
  type AiToolCall,
  type DataObject,
  type Item,
  NodeOperationError,
  type ToolResumeData,
  type ToolSuspension,
  type WorkflowNode,
} from '@workflow/workflow';
import { markToolError, rawContentOf, restoreRawContent } from '../../shared/markers';

const CHECKPOINT_VERSION = 1;

/** the raw content of `messages[message]`; `fallback` when the fallback model made it */
export interface StoredRawContent {
  message: number;
  raw: unknown;
  fallback?: boolean;
}

/** the agent loop at the moment a tool stopped it */
export type AgentLoopState = {
  messages: AiChatMessage[];
  /** which message holds the prompt: the attachments go back on it */
  promptIndex: number;
  /** JSON of the loop's steps and usage */
  steps: unknown[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number };
  iterations: number;
  /** the output parser's one retry has been used */
  parseRetried: boolean;
  /** part of the answer has already gone out as a stream */
  streamed: boolean;
  /** the turn under way: results so far, the call that waits, the calls not started */
  results: AiChatMessage[];
  waiting: { call: AiToolCall; gatedTool?: { name: string; arguments: DataObject } };
  pending: AiToolCall[];
  rawContent?: StoredRawContent[];
};

export type AgentCheckpoint = AgentLoopState & {
  version: number;
  /** the item that stopped; the ones before it are done */
  itemIndex: number;
  finishedItems: Item[];
};

/** thrown by the loop when a tool stops the run; the node hands both fields to `ctx.suspendForTool` */
export class AgentSuspended extends Error {
  constructor(
    readonly suspension: ToolSuspension,
    readonly state: AgentLoopState,
  ) {
    super(suspension.message);
    this.name = 'AgentSuspended';
  }
}

/**
 * The text of a message; image and file parts stay behind. The prompt message keeps its first part, the prompt: the
 * parts after it are attachments, and a text file among them comes back from the binary like any other.
 */
function withoutFileData(message: AiChatMessage, isPrompt: boolean): AiChatMessage {
  if (typeof message.content === 'string') return message;
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return { ...message, content: isPrompt ? (text[0] ?? '') : text.join('') };
}

export function storableMessages(messages: AiChatMessage[], promptIndex: number): AiChatMessage[] {
  return messages.map((message, index) => withoutFileData(message, index === promptIndex));
}

/** the raw content the adapters hold for `messages`, which storing them as text would lose */
export function storableRawContent(
  messages: AiChatMessage[],
  madeByFallback: WeakSet<AiChatMessage>,
): StoredRawContent[] {
  return messages.flatMap((message, index) => {
    const raw = rawContentOf(message);
    if (raw === undefined) return [];
    return [{ message: index, raw, ...(madeByFallback.has(message) ? { fallback: true } : {}) }];
  });
}

/** the steps say which calls failed: the flag on a tool's message does not go through JSON */
function restoreToolErrors(state: AgentLoopState): void {
  const failed = new Set(
    state.steps.flatMap((step) => {
      const { error, action } = (step ?? {}) as { error?: unknown; action?: { toolCallId?: unknown } };
      return error === true && typeof action?.toolCallId === 'string' ? [action.toolCallId] : [];
    }),
  );
  for (const message of [...state.messages, ...state.results]) {
    if (message.role === 'tool' && message.toolCallId && failed.has(message.toolCallId)) markToolError(message);
  }
}

/** the messages of a checkpoint, with the prompt's attachments, the raw content and the failed tools back in place */
export function restoreMessages(state: AgentLoopState, attachments?: AiContentPart[]): AiChatMessage[] {
  restoreToolErrors(state);
  const messages = attachments?.length
    ? state.messages.map((message, index) =>
        index === state.promptIndex
          ? { ...message, content: [{ type: 'text' as const, text: String(message.content) }, ...attachments] }
          : message,
      )
    : [...state.messages];
  for (const { message, raw } of state.rawContent ?? []) {
    const target = messages[message];
    if (target) restoreRawContent(target, raw);
  }
  return messages;
}

export function createCheckpoint(
  state: AgentLoopState,
  itemIndex: number,
  finishedItems: Item[],
): DataObject {
  const checkpoint: AgentCheckpoint = { ...state, version: CHECKPOINT_VERSION, itemIndex, finishedItems };
  return checkpoint;
}

function isCheckpoint(stored: DataObject, toolCallId: string): stored is DataObject & AgentCheckpoint {
  const { version, messages, steps, results, pending, usage, rawContent } = stored;
  const waiting = stored.waiting as Partial<AgentLoopState['waiting']> | null | undefined;
  return (
    version === CHECKPOINT_VERSION &&
    waiting?.call?.id === toolCallId &&
    [messages, steps, results, pending].every((list) => Array.isArray(list)) &&
    usage !== null &&
    typeof usage === 'object' &&
    !Array.isArray(usage) &&
    (rawContent === undefined || Array.isArray(rawContent))
  );
}

export function readCheckpoint(node: WorkflowNode, resume: ToolResumeData): AgentCheckpoint {
  const { checkpoint, toolCallId } = resume;
  if (!isCheckpoint(checkpoint, toolCallId)) {
    throw new NodeOperationError(node, 'This run cannot continue from the point where it waited');
  }
  return checkpoint;
}
