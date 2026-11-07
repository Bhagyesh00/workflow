/**
 * What an agent keeps while its run waits for a tool. It is stored with the execution as JSON, so it holds what
 * the agent has said and done and nothing it can read again: no image or file data (the resumed run reads those
 * from the item's binary) and no credential (the resumed run gets its sub-nodes from the engine again).
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

const CHECKPOINT_VERSION = 1;

/** the agent loop at the moment a tool stopped it */
export interface AgentLoopState {
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
}

export interface AgentCheckpoint extends AgentLoopState {
  version: number;
  /** the item that stopped; the ones before it are done */
  itemIndex: number;
  finishedItems: Item[];
}

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

/** the text of a message; image and file parts stay behind */
function withoutFileData(message: AiChatMessage): AiChatMessage {
  if (typeof message.content === 'string') return message;
  const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return { ...message, content: text.join('') };
}

export function storableMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages.map(withoutFileData);
}

/** the messages of a checkpoint, with the prompt's attachments back in their place */
export function restoreMessages(state: AgentLoopState, attachments?: AiContentPart[]): AiChatMessage[] {
  if (!attachments?.length) return [...state.messages];
  return state.messages.map((message, index) =>
    index === state.promptIndex
      ? { ...message, content: [{ type: 'text', text: String(message.content) }, ...attachments] }
      : message,
  );
}

export function createCheckpoint(
  state: AgentLoopState,
  itemIndex: number,
  finishedItems: Item[],
): DataObject {
  const checkpoint: AgentCheckpoint = { ...state, version: CHECKPOINT_VERSION, itemIndex, finishedItems };
  return checkpoint as unknown as DataObject;
}

export function readCheckpoint(node: WorkflowNode, resume: ToolResumeData): AgentCheckpoint {
  const checkpoint = resume.checkpoint as unknown as AgentCheckpoint;
  if (checkpoint.version !== CHECKPOINT_VERSION || checkpoint.waiting?.call?.id !== resume.toolCallId) {
    throw new NodeOperationError(node, 'This run cannot continue from the point where it waited');
  }
  return checkpoint;
}
