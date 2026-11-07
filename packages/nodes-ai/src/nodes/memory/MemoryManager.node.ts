/**
 * Chat Memory Manager: reads, inserts or deletes the messages of a connected chat memory. It works on
 * the full stored history (`loadAll`, `replace`), not on the window the model sees, so deleting the last
 * messages never drops older ones.
 */
import {
  type AiChatMessage,
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import { getMemory, type SessionMemory } from '../../shared/ai-inputs';
import { collectionList, messageText } from '../../shared/utils';

const MAX_DELETE = 10_000;

interface MessageRow {
  type?: string;
  message?: string;
  hideFromUI?: boolean;
}

const TYPE_NAME: Record<AiChatMessage['role'], string> = {
  user: 'human',
  assistant: 'ai',
  system: 'system',
  tool: 'tool',
};

function roleOf(type: string | undefined): 'user' | 'assistant' | 'system' {
  if (type === 'ai') return 'assistant';
  if (type === 'system') return 'system';
  return 'user';
}

/** `{type, content, additional_kwargs}`: our own shape, not LangChain's serialized message */
function plain(message: AiChatMessage): DataObject {
  return {
    type: TYPE_NAME[message.role],
    content: messageText(message.content),
    additional_kwargs: message.hideFromUI === true ? { hideFromUI: true } : {},
  };
}

/** `{human: text, ai: text}` groups; a new group starts when a type repeats inside the current one */
function simplify(messages: AiChatMessage[]): DataObject[] {
  const groups: DataObject[] = [];
  let current: DataObject = {};
  for (const message of messages) {
    const key = TYPE_NAME[message.role];
    if (key in current) {
      groups.push(current);
      current = {};
    }
    current[key] = messageText(message.content);
  }
  if (Object.keys(current).length) groups.push(current);
  return groups;
}

function resultItems(entries: DataObject[], group: boolean, itemIndex: number): Item[] {
  if (group) {
    return [{ json: { messages: entries, messagesCount: entries.length }, pairedItem: { item: itemIndex } }];
  }
  return entries.map((json) => ({ json, pairedItem: { item: itemIndex } }));
}

async function sessionOf(ctx: ExecuteContext, itemIndex: number): Promise<{ memory: SessionMemory; id: string }> {
  const memory = await getMemory(ctx, itemIndex);
  if (!memory) {
    throw new NodeOperationError(ctx.getNode(), 'Connect a memory to this node', { itemIndex });
  }
  if (!memory.sessionId) {
    throw new NodeOperationError(ctx.getNode(), 'The connected memory has no session key', { itemIndex });
  }
  return { memory, id: memory.sessionId };
}

function newMessages(ctx: ExecuteContext, itemIndex: number): AiChatMessage[] {
  const rows = collectionList<MessageRow>(ctx.getNodeParameter('messages', itemIndex, {}), 'messageValues');
  if (!rows.length) {
    throw new NodeOperationError(ctx.getNode(), 'Add at least one message to insert', {
      itemIndex,
      parameter: 'messages',
    });
  }
  return rows.map((row) => {
    const message: AiChatMessage = { role: roleOf(row.type), content: row.message ?? '' };
    if (row.hideFromUI === true) message.hideFromUI = true;
    return message;
  });
}

async function handle(ctx: ExecuteContext, itemIndex: number): Promise<Item[]> {
  const mode = String(ctx.getNodeParameter('mode', itemIndex, 'load'));
  const { memory, id } = await sessionOf(ctx, itemIndex);

  if (mode === 'load') {
    const messages = await memory.loadAll(id);
    const simplified = ctx.getNodeParameter('simplifyOutput', itemIndex, true) !== false;
    const options = (ctx.getNodeParameter('options', itemIndex, {}) ?? {}) as DataObject;
    const group = options.groupMessages !== false;
    return resultItems(simplified ? simplify(messages) : messages.map(plain), group, itemIndex);
  }

  if (mode === 'insert') {
    const added = newMessages(ctx, itemIndex);
    if (ctx.getNodeParameter('insertMode', itemIndex, 'insert') === 'override') {
      await memory.replace(id, added);
    } else {
      await memory.append(id, added);
    }
  } else if (mode === 'delete') {
    if (ctx.getNodeParameter('deleteMode', itemIndex, 'lastN') === 'all') {
      await memory.clear(id);
    } else {
      const count = Math.floor(Number(ctx.getNodeParameter('lastMessagesCount', itemIndex, 2)));
      if (!Number.isFinite(count) || count < 1 || count > MAX_DELETE) {
        throw new NodeOperationError(
          ctx.getNode(),
          `The number of messages to delete must be between 1 and ${MAX_DELETE}`,
          { itemIndex, parameter: 'lastMessagesCount' },
        );
      }
      const all = await memory.loadAll(id);
      await memory.replace(id, all.slice(0, Math.max(0, all.length - count)));
    }
  } else {
    throw new NodeOperationError(ctx.getNode(), `Unknown mode "${mode}"`, { itemIndex, parameter: 'mode' });
  }

  // insert and delete answer with the history as it is now
  return resultItems((await memory.loadAll(id)).map(plain), true, itemIndex);
}

export const MemoryManagerNode: NodeType = {
  description: {
    name: 'ai.memoryManager',
    displayName: 'Chat Memory Manager',
    description: 'Loads, inserts or deletes the messages of a chat memory',
    icon: 'lucide:database',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Chat Memory Manager' },
    inputs: ['main', { type: 'ai_memory', displayName: 'Memory', required: true, maxConnections: 1 }],
    outputs: ['main'],
    categories: ['AI', 'Memory'],
    alias: ['chat history', 'conversation', 'memory'],
    properties: [
      {
        displayName: 'Operation Mode',
        name: 'mode',
        type: 'options',
        noDataExpression: true,
        default: 'load',
        options: [
          { name: 'Get Many Messages', value: 'load', description: 'Read the stored messages' },
          { name: 'Insert Messages', value: 'insert', description: 'Add messages to the conversation' },
          { name: 'Delete Messages', value: 'delete', description: 'Remove messages from the conversation' },
        ],
      },
      {
        displayName: 'Insert Mode',
        name: 'insertMode',
        type: 'options',
        default: 'insert',
        options: [
          { name: 'Insert Messages', value: 'insert', description: 'Add to the stored messages' },
          { name: 'Override All Messages', value: 'override', description: 'Replace the stored messages' },
        ],
        displayOptions: { show: { mode: ['insert'] } },
      },
      {
        displayName: 'Delete Mode',
        name: 'deleteMode',
        type: 'options',
        default: 'lastN',
        options: [
          { name: 'Last N', value: 'lastN', description: 'Delete the most recent messages' },
          { name: 'All Messages', value: 'all', description: 'Delete the whole conversation' },
        ],
        displayOptions: { show: { mode: ['delete'] } },
      },
      {
        displayName: 'Messages Count',
        name: 'lastMessagesCount',
        type: 'number',
        default: 2,
        typeOptions: { minValue: 1 },
        description: 'How many of the most recent messages to delete',
        displayOptions: { show: { mode: ['delete'], deleteMode: ['lastN'] } },
      },
      {
        displayName: 'Messages',
        name: 'messages',
        type: 'fixedCollection',
        default: {},
        typeOptions: { multipleValues: true, sortable: true },
        placeholder: 'Add message',
        displayOptions: { show: { mode: ['insert'] } },
        options: [
          {
            displayName: 'Message',
            name: 'messageValues',
            values: [
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                default: 'user',
                options: [
                  { name: 'AI', value: 'ai' },
                  { name: 'System', value: 'system' },
                  { name: 'User', value: 'user' },
                ],
              },
              {
                displayName: 'Message',
                name: 'message',
                type: 'string',
                default: '',
                required: true,
                typeOptions: { rows: 3 },
              },
              {
                displayName: 'Hide Message in Chat',
                name: 'hideFromUI',
                type: 'boolean',
                default: false,
                description: 'Whether to keep the message in memory but not show it in the chat window',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Simplify Output',
        name: 'simplifyOutput',
        type: 'boolean',
        default: true,
        description:
          'Whether to return {human: text} and {ai: text} groups. When off, each message is {type, content, additional_kwargs} (this is not the LangChain serialized shape).',
        displayOptions: { show: { mode: ['load'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['load'] } },
        options: [
          {
            displayName: 'Group Messages',
            name: 'groupMessages',
            type: 'boolean',
            default: true,
            description: 'Whether to return all messages in one item instead of one item per entry',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const out: Item[] = [];
    // items run in order: two items of one session see each other's changes
    for (let i = 0; i < ctx.getInputData().length; i++) {
      try {
        out.push(...(await handle(ctx, i)));
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        const message = error instanceof Error ? error.message : String(error);
        out.push({ json: { error: message }, error: { message }, pairedItem: { item: i } });
      }
    }
    return [out];
  },
};
