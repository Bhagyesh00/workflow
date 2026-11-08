/**
 * Respond to Chat (P5-58, n8n "Respond to Chat", `ai.chat`): sends a message to the chat of a Chat Trigger
 * whose Response Mode is "Using Response Nodes", or sends one and waits for the person's reply (approval,
 * free text or a form, from the send-and-wait kit). The reply arrives on the `chatReply` POST of the
 * waiting run's resume URL (chat-reply.ts); an approval button opens the kit's `answer` link.
 * As a tool (`ai.chatTool`) it sends and returns `{...json, sendMessage, sent: true}` (the run keeps the sent
 * message, as n8n's `sendMessage`); its Human review copy is
 * `ai.chatHitlTool`, made by S1's rule from the Send and Wait operation.
 *
 * Messages are data: the text goes to the stream as it is and the widget escapes it.
 */
import {
  SEND_AND_WAIT,
  type SendAndWaitMessage,
  sendAndWait,
  sendAndWaitProperties,
  sendAndWaitWebhook,
  sendAndWaitWebhooks,
} from '@workflow/nodes-base/utils/send-and-wait';
import {
  CHAT_TOOL_TYPE,
  type DataObject,
  type ExecuteContext,
  highlightedResponseKey,
  type Item,
  isPlainObject,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { getMemory } from '../../shared/ai-inputs';
import { chatReply } from './chat-reply';

const MEMORY_INPUT = "{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }";

export const NO_CHAT_TRIGGER = 'Workflow must be started from a chat trigger node';
export const WRONG_RESPONSE_MODE =
  '"Response Mode" in the chat trigger node must be set to "Using Response Nodes"';
export const FIRST_ITEM_HINT =
  'Only the message of the first input item was sent. Put a Loop Over Items node before this node to send one message per item.';

/** the options of both operations */
const chatOptions: NodeProperty[] = [
  {
    displayName: 'Add Memory Input Connection',
    name: 'memoryConnection',
    type: 'boolean',
    default: false,
    description: 'Whether to connect a memory, which stores the message as an AI message of the session',
  },
  {
    displayName: 'Auto-save Highlighted Data',
    name: 'autoSaveHighlightedData',
    type: 'boolean',
    default: true,
    description:
      'Whether the message is saved on the execution, so the Execution Data node and the executions list can use it',
  },
];

const SEND_SHOW = { operation: ['send'] };

/** the kit's parameters for Send and Wait, each of its option lists with the chat options in front */
const waitProperties: NodeProperty[] = sendAndWaitProperties({ operation: [SEND_AND_WAIT] }).map(
  (property) =>
    property.name === 'options' && property.type === 'collection'
      ? { ...property, options: [...chatOptions, ...(property.options as NodeProperty[])] }
      : property,
);

/** what the chat shows: an approval is a buttons message, a form a link to its page, free text the message */
export function chatMessageOf(planned: SendAndWaitMessage): string {
  if (planned.responseType === 'approval') {
    return JSON.stringify({
      type: 'with-buttons',
      text: planned.message,
      buttons: planned.buttons.map((button) => ({
        text: button.label,
        link: button.url,
        type: button.style,
      })),
      blockUserInput: false,
    });
  }
  if (planned.responseType === 'customForm') {
    const links = planned.buttons.map((button) => `[${button.label.replace(/[[\]]/g, '')}](${button.url})`);
    return [planned.message, ...links].join('\n\n');
  }
  return planned.message;
}

/** the Chat Trigger checks of n8n, the same as a main node and as a tool */
function assertChatTrigger(ctx: ExecuteContext): void {
  const trigger = ctx.getChatTrigger();
  if (!trigger) throw new NodeOperationError(ctx.getNode(), NO_CHAT_TRIGGER);
  const options = isPlainObject(trigger.parameters.options) ? trigger.parameters.options : {};
  if (options.responseMode !== 'responseNodes') {
    throw new NodeOperationError(ctx.getNode(), WRONG_RESPONSE_MODE);
  }
}

/** the message as the memory's AI message, and as the run's highlighted data */
async function keep(ctx: ExecuteContext, options: DataObject, item: Item | undefined, text: string) {
  if (options.memoryConnection === true) {
    const memory = await getMemory(ctx, 0);
    if (memory) {
      const sessionId =
        memory.sessionId ?? (typeof item?.json.sessionId === 'string' ? item.json.sessionId : undefined);
      if (!sessionId) {
        throw new NodeOperationError(ctx.getNode(), 'No session ID found', {
          description: 'Connect a Chat Trigger node or set a session key in the memory node.',
        });
      }
      await memory.append(sessionId, [{ role: 'assistant', content: text }]);
    }
  }
  if (options.autoSaveHighlightedData !== false) {
    ctx.setCustomData(highlightedResponseKey(ctx.getNode().name), text);
  }
}

/** a tool's result: its input with the sent message and `sent: true`, without an empty `chatInput` */
function toolResult(json: DataObject, sendMessage: string): DataObject {
  const { chatInput, ...rest } = json;
  return {
    ...rest,
    ...(typeof chatInput === 'string' && chatInput.trim() ? { chatInput } : {}),
    sendMessage,
    sent: true,
  };
}

export const ChatNode: NodeType = {
  description: {
    name: 'ai.chat',
    displayName: 'Respond to Chat',
    description: 'Sends a message to the chat and can wait for the reply',
    icon: 'lucide:message-square-reply',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Respond to Chat' },
    inputs: `={{ ['main', ...($parameter.options?.memoryConnection === true ? [${MEMORY_INPUT}] : [])] }}`,
    outputs: ['main'],
    categories: ['AI', 'Human in the Loop'],
    alias: ['chat', 'reply', 'respond', 'message', 'human in the loop'],
    usableAsTool: true,
    webhooks: [
      ...sendAndWaitWebhooks,
      {
        name: 'chatReply',
        httpMethod: 'POST',
        path: 'chat-reply',
        restartWebhook: true,
        responseMode: 'responseNodes',
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'send',
        noDataExpression: true,
        options: [
          { name: 'Send Message', value: 'send', action: 'Send a message' },
          {
            name: 'Send and Wait for Response',
            value: SEND_AND_WAIT,
            action: 'Send a message and wait for response',
          },
        ],
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 4 },
        description: 'The message to send to the chat',
        displayOptions: { show: SEND_SHOW },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: chatOptions,
        displayOptions: { show: SEND_SHOW },
      },
      ...waitProperties,
    ],
  },

  async execute(ctx) {
    assertChatTrigger(ctx);
    const items = ctx.getInputData();
    const options = ctx.getNodeParameter('options', 0, {}) as DataObject;

    if (ctx.getNodeParameter('operation', 0, 'send') === SEND_AND_WAIT) {
      return sendAndWait(ctx, async (planned) => {
        ctx.sendChunk(chatMessageOf(planned));
        await keep(ctx, options, items[0], planned.message);
      });
    }

    const message = String(ctx.getNodeParameter('message', 0, '') ?? '');
    if (!message.trim()) throw new NodeOperationError(ctx.getNode(), 'The message is empty');
    ctx.sendChunk(message);
    await keep(ctx, options, items[0], message);
    if (items.length > 1) ctx.addExecutionHints({ message: FIRST_ITEM_HINT, level: 'info' });
    if (ctx.getNode().type === CHAT_TOOL_TYPE) {
      return [[{ json: toolResult(items[0]?.json ?? {}, message), pairedItem: { item: 0 } }]];
    }
    return [items];
  },

  async webhook(ctx) {
    return ctx.getWebhookName() === 'chatReply' ? chatReply(ctx) : sendAndWaitWebhook(ctx);
  },
};
