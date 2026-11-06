/** Stub of RabbitMQ: final name and description; L19 (P4-26) builds it. */
import type { NodeType } from '@workflow/workflow';

export const RabbitMqNode: NodeType = {
  description: {
    name: 'app.rabbitmq',
    displayName: 'RabbitMQ',
    description: 'Sends messages to a queue or exchange and deletes messages from a queue',
    icon: 'simple:rabbitmq',
    iconColor: '#ff6600',
    group: ['transform'],
    version: 1,
    defaults: { name: 'RabbitMQ' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools'],
    alias: ['rabbitmq', 'rabbit', 'amqp', 'message', 'queue', 'broker'],
    credentials: [{ name: 'rabbitmq', required: true }],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
