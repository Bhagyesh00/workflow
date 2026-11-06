/** Stub of RabbitMQ Trigger: final name and description; L19 (P4-14) builds it. */
import type { NodeType } from '@workflow/workflow';

export const RabbitMqTriggerNode: NodeType = {
  description: {
    name: 'app.rabbitmqTrigger',
    displayName: 'RabbitMQ Trigger',
    description: 'Consumes a queue with acknowledge modes',
    icon: 'simple:rabbitmq',
    iconColor: '#ff6600',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'RabbitMQ Trigger' },
    inputs: [],
    outputs: ['main'],
    categories: ['Developer tools', 'Triggers'],
    credentials: [{ name: 'rabbitmq', required: true }],
    properties: [],
  },

  async trigger() {
    throw new Error('Not built yet');
  },
};
