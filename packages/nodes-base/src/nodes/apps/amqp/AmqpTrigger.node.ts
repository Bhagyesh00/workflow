/** Stub of AMQP Trigger: final name and description; L21 (P4-28) builds it. */
import type { NodeType } from '@workflow/workflow';

export const AmqpTriggerNode: NodeType = {
  description: {
    name: 'app.amqpTrigger',
    displayName: 'AMQP Trigger',
    description: 'Starts a run on AMQP 1.0 messages from a queue or topic',
    icon: 'simple:amqp',
    iconColor: '#ff6600',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'AMQP Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Communication', 'Triggers'],
    credentials: [{ name: 'amqp', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
