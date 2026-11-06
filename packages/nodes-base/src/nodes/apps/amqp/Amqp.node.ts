/** Stub of AMQP Sender: final name and description; L21 (P4-28) builds it. */
import type { NodeType } from '@workflow/workflow';

export const AmqpNode: NodeType = {
  description: {
    name: 'app.amqp',
    displayName: 'AMQP Sender',
    description: 'Sends messages to an AMQP 1.0 queue or topic',
    icon: 'simple:amqp',
    iconColor: '#ff6600',
    group: ['output'],
    version: 1,
    defaults: { name: 'AMQP Sender' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication'],
    alias: ['amqp', 'amqp 1.0', 'message', 'queue', 'topic', 'broker'],
    credentials: [{ name: 'amqp', required: true }],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
