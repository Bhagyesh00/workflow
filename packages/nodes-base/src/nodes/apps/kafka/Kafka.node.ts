/** Stub of Kafka: final name and description; L18 (P4-25) builds it. */
import type { NodeType } from '@workflow/workflow';

export const KafkaNode: NodeType = {
  description: {
    name: 'app.kafka',
    displayName: 'Kafka',
    description: 'Sends messages to a Kafka topic',
    icon: 'simple:apachekafka',
    iconColor: '#231f20',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Kafka' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Developer tools'],
    alias: ['kafka', 'apache kafka', 'message', 'topic', 'broker', 'stream'],
    credentials: [{ name: 'kafka', required: true }],
    properties: [],
  },

  async execute() {
    throw new Error('Not built yet');
  },
};
