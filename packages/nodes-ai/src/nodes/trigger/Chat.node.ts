/**
 * Respond to Chat (P5-58, n8n "Respond to Chat", `ai.chat`): sends a message to the chat of a Chat Trigger
 * whose Response Mode is "Using Response Nodes", or sends one and waits for the person's reply (approval,
 * free text or a form, from the send-and-wait kit). The reply arrives on the `chatReply` POST of the
 * waiting run's resume URL. As a tool (`ai.chatTool`) it sends; its Human review copy is `ai.chatHitlTool`.
 * Stub from C0: lane L2 writes it.
 */
import { SEND_AND_WAIT, sendAndWaitWebhooks } from '@workflow/nodes-base/utils/send-and-wait';
import type { NodeType } from '@workflow/workflow';

const MEMORY_INPUT = "{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }";

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
    ],
  },

  async execute() {
    throw new Error('not implemented (L2)');
  },

  async webhook() {
    throw new Error('not implemented (L2)');
  },
};
